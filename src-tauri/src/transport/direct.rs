use super::session::Retirement;
use futures_util::stream::{FuturesUnordered, StreamExt};
use std::{
    future::Future,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::net::TcpStream;
use tokio_util::sync::CancellationToken;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_ADDRESSES: usize = 64;
const MAX_ATTEMPTS: usize = 8;
const ATTEMPT_DELAY: Duration = Duration::from_millis(50);
#[cfg(not(test))]
const ATTEMPT_LIFETIME: Duration = Duration::from_secs(5);
#[cfg(test)]
const ATTEMPT_LIFETIME: Duration = Duration::from_millis(250);

fn public_address(address: SocketAddr) -> bool {
    if address.port() != 443 {
        return false;
    }
    match address.ip() {
        IpAddr::V4(ip) => {
            let [a, b, c, _] = ip.octets();
            !(a == 0
                || a == 10
                || a == 127
                || a >= 224
                || a == 100 && (64..=127).contains(&b)
                || a == 169 && b == 254
                || a == 172 && (16..=31).contains(&b)
                || a == 192 && (b == 168 || b == 0 && (c == 0 || c == 2) || b == 88 && c == 99)
                || a == 198 && (b == 18 || b == 19 || b == 51 && c == 100)
                || a == 203 && b == 0 && c == 113)
        }
        IpAddr::V6(ip) => {
            let [a, b, ..] = ip.segments();
            (0x2000..=0x3fff).contains(&a)
                && !(a == 0x2001 && (b < 0x0200 || b == 0x0db8)
                    || a == 0x2002
                    || a == 0x3fff && b < 0x1000)
                && matches!(address, SocketAddr::V6(address) if address.scope_id() == 0)
        }
    }
}

async fn connect_with<R, RF, C, CF, T, E>(
    resolve: R,
    mut connect: C,
    cancel: &CancellationToken,
) -> Result<T, String>
where
    R: FnOnce() -> RF,
    RF: Future<Output = Result<Vec<SocketAddr>, String>>,
    C: FnMut(SocketAddr) -> CF,
    CF: Future<Output = Result<T, E>> + Send + 'static,
    T: Send + 'static,
    E: Send + 'static,
{
    let work = async {
        let addresses = resolve().await?;
        if addresses.is_empty()
            || addresses.len() > MAX_ADDRESSES
            || addresses.iter().any(|address| !public_address(*address))
        {
            return Err("direct DNS returned a non-public or unsupported target".into());
        }
        let mut pending = addresses.into_iter().peekable();
        if cancel.is_cancelled() {
            return Err("private request cancelled".into());
        }
        let mut attempts: FuturesUnordered<_> = FuturesUnordered::new();
        for address in pending.by_ref().take(MAX_ATTEMPTS) {
            let connection = connect(address);
            attempts.push(Box::pin(async move {
                tokio::time::timeout(ATTEMPT_LIFETIME, connection)
                    .await
                    .map_err(|_| ())?
                    .map_err(|_| ())
            })
                as std::pin::Pin<Box<dyn Future<Output = Result<T, ()>> + Send>>);
        }
        loop {
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err("private request cancelled".into()),
                result = attempts.next() => {
                    match result {
                        Some(Ok(stream)) => return Ok(stream),
                        Some(Err(_)) if attempts.is_empty() && pending.peek().is_none() => return Err("direct connection failed".into()),
                        Some(Err(_)) => {},
                        None if pending.peek().is_none() => return Err("direct connection failed".into()),
                        None => {},
                    }
                },
                _ = tokio::time::sleep_until((std::time::Instant::now() + ATTEMPT_DELAY).into()) => {},
            }
            while attempts.len() < MAX_ATTEMPTS {
                let Some(address) = pending.next() else { break };
                let connection = connect(address);
                attempts.push(Box::pin(async move {
                    tokio::time::timeout(ATTEMPT_LIFETIME, connection)
                        .await
                        .map_err(|_| ())?
                        .map_err(|_| ())
                })
                    as std::pin::Pin<Box<dyn Future<Output = Result<T, ()>> + Send>>);
            }
        }
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("private request cancelled".into()),
        result = tokio::time::timeout(CONNECT_TIMEOUT, work) =>
            result.map_err(|_| "direct connection timed out".to_owned())?,
    }
}

pub(super) async fn connect(
    host: &str,
    cancel: &CancellationToken,
    retirement: Arc<Retirement>,
) -> Result<TcpStream, String> {
    let host = host.to_owned();
    connect_with(
        move || async move {
            // OS DNS may outlive cancellation; its guard keeps the next mode blocked.
            tokio::spawn(async move {
                let _retirement = retirement;
                tokio::net::lookup_host((host.as_str(), 443))
                    .await
                    .map(|addresses| addresses.take(MAX_ADDRESSES + 1).collect())
                    .map_err(|_| "direct DNS lookup failed".to_owned())
            })
            .await
            .map_err(|_| "direct DNS task failed".to_owned())?
        },
        TcpStream::connect,
        cancel,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn address(value: &str) -> SocketAddr {
        value.parse().unwrap()
    }

    #[test]
    fn only_public_unicast_addresses_on_tls_port_are_supported() {
        for value in ["8.8.8.8:443", "1.1.1.1:443", "[2606:4700:4700::1111]:443"] {
            assert!(public_address(address(value)), "{value}");
        }
        for value in [
            "0.1.2.3:443",
            "10.0.0.1:443",
            "100.64.0.1:443",
            "127.0.0.1:443",
            "169.254.169.254:443",
            "172.31.0.1:443",
            "192.168.0.1:443",
            "192.0.0.1:443",
            "192.0.2.1:443",
            "192.88.99.1:443",
            "198.18.0.1:443",
            "198.51.100.1:443",
            "203.0.113.1:443",
            "224.0.0.1:443",
            "240.0.0.1:443",
            "255.255.255.255:443",
            "8.8.8.8:80",
            "[::]:443",
            "[::1]:443",
            "[::ffff:8.8.8.8]:443",
            "[fc00::1]:443",
            "[fe80::1]:443",
            "[ff02::1]:443",
            "[64:ff9b::808:808]:443",
            "[2001::1]:443",
            "[2001:db8::1]:443",
            "[2002:808:808::1]:443",
            "[3fff::1]:443",
        ] {
            assert!(!public_address(address(value)), "{value}");
        }
    }

    #[tokio::test]
    async fn a_mixed_dns_result_never_connects_even_to_its_public_address() {
        let calls = AtomicUsize::new(0);
        let result = connect_with(
            || async { Ok(vec![address("8.8.8.8:443"), address("127.0.0.1:443")]) },
            |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Ok::<_, ()>(()))
            },
            &CancellationToken::new(),
        )
        .await;
        assert!(result.unwrap_err().contains("non-public"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn resolves_once_and_connects_only_the_validated_addresses() {
        let resolutions = AtomicUsize::new(0);
        let mut attempts = Vec::new();
        let addresses = vec![address("8.8.8.8:443"), address("1.1.1.1:443")];
        let result = connect_with(
            || {
                resolutions.fetch_add(1, Ordering::SeqCst);
                std::future::ready(Ok(addresses.clone()))
            },
            |address| {
                attempts.push(address);
                std::future::ready(if attempts.len() == 1 { Err(()) } else { Ok(7) })
            },
            &CancellationToken::new(),
        )
        .await;
        assert_eq!(result, Ok(7));
        assert_eq!(resolutions.load(Ordering::SeqCst), 1);
        assert_eq!(attempts, addresses);
    }

    #[tokio::test]
    async fn cancellation_during_resolution_or_connect_returns_without_retry() {
        for during_resolution in [true, false] {
            let cancel = CancellationToken::new();
            let mut calls = 0;
            let result = connect_with(
                || {
                    if during_resolution {
                        cancel.cancel();
                    }
                    std::future::ready(Ok(vec![address("8.8.8.8:443")]))
                },
                |_| {
                    calls += 1;
                    cancel.cancel();
                    std::future::pending::<Result<(), ()>>()
                },
                &cancel,
            )
            .await;
            assert!(result.unwrap_err().contains("cancelled"));
            assert_eq!(calls, usize::from(!during_resolution));
        }
    }

    #[tokio::test]
    async fn a_stalled_address_does_not_hide_a_reachable_later_address() {
        let first = address("8.8.8.8:443");
        let second = address("1.1.1.1:443");
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            connect_with(
                || async { Ok(vec![first, second]) },
                move |address| async move {
                    if address == first {
                        std::future::pending::<Result<u8, ()>>().await
                    } else {
                        tokio::time::sleep(Duration::from_millis(20)).await;
                        Ok(11)
                    }
                },
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("reachable later address must finish promptly");
        assert_eq!(result, Ok(11));
        tokio::task::yield_now().await;
    }

    #[tokio::test]
    async fn connection_attempts_are_bounded_and_later_addresses_can_succeed() {
        let concurrent = Arc::new(AtomicUsize::new(0));
        let maximum = Arc::new(AtomicUsize::new(0));
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            connect_with(
                || async {
                    Ok((1..=12)
                        .map(|last| address(&format!("8.8.8.{last}:443")))
                        .collect())
                },
                |address| {
                    let concurrent = concurrent.clone();
                    let maximum = maximum.clone();
                    async move {
                        let active = concurrent.fetch_add(1, Ordering::SeqCst) + 1;
                        maximum.fetch_max(active, Ordering::SeqCst);
                        tokio::time::sleep(Duration::from_millis(10)).await;
                        concurrent.fetch_sub(1, Ordering::SeqCst);
                        if address.to_string() == "8.8.8.9:443" {
                            Ok(17)
                        } else {
                            Err(())
                        }
                    }
                },
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("bounded attempts must reach the ninth address");
        assert_eq!(result, Ok(17));
        assert!(maximum.load(Ordering::SeqCst) <= 8);
        tokio::task::yield_now().await;
    }

    #[tokio::test]
    async fn stalled_attempts_expire_and_losing_attempts_finish_before_cancellation() {
        let cleaned = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            connect_with(
                || async {
                    Ok((1..=9)
                        .map(|last| address(&format!("8.8.8.{last}:443")))
                        .collect())
                },
                |address| {
                    let cleaned = cleaned.clone();
                    let cancel = cancel.clone();
                    async move {
                        struct Cleanup(Arc<AtomicUsize>);
                        impl Drop for Cleanup {
                            fn drop(&mut self) {
                                self.0.fetch_add(1, Ordering::SeqCst);
                            }
                        }
                        let _cleanup = Cleanup(cleaned);
                        if address.to_string() == "8.8.8.9:443" {
                            cancel.cancel();
                        }
                        std::future::pending::<Result<u8, ()>>().await
                    }
                },
                &cancel,
            ),
        )
        .await
        .expect("stalled attempts must expire instead of blocking every address");
        assert!(result.unwrap_err().contains("cancelled"));
        assert_eq!(cleaned.load(Ordering::SeqCst), 9);
    }

    #[tokio::test]
    async fn failed_attempt_refills_available_capacity_without_another_delay() {
        let calls = AtomicUsize::new(0);
        let start = std::time::Instant::now();
        let result = tokio::time::timeout(
            ATTEMPT_DELAY,
            connect_with(
                || async {
                    Ok((1..=3)
                        .map(|last| address(&format!("8.8.8.{last}:443")))
                        .collect())
                },
                |_| {
                    let attempt = calls.fetch_add(1, Ordering::SeqCst) + 1;
                    async move { if attempt < 3 { Err(()) } else { Ok(19) } }
                },
                &CancellationToken::new(),
            ),
        )
        .await
        .expect("a failed attempt must release its slot without waiting for the stagger");
        assert_eq!(result, Ok(19));
        assert!(start.elapsed() < ATTEMPT_DELAY);
    }
}
