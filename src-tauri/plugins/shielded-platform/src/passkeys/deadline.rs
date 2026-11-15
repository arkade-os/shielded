use super::PasskeyError;
use std::{
    future::Future,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Clone)]
pub(super) struct DeadlineTicket(Arc<AtomicBool>);
impl DeadlineTicket {
    pub(super) fn new() -> Self {
        Self(Arc::new(AtomicBool::new(true)))
    }
    pub(super) fn active(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    pub(super) fn retire(&self) -> bool {
        self.0.swap(false, Ordering::AcqRel)
    }
}
pub(super) fn take_owned<T>(
    slot: &mut Option<(DeadlineTicket, T)>,
    ticket: &DeadlineTicket,
) -> Option<T> {
    if slot
        .as_ref()
        .is_some_and(|(owner, _)| Arc::ptr_eq(&owner.0, &ticket.0))
    {
        slot.take().map(|(_, value)| value)
    } else {
        None
    }
}
pub(super) async fn await_deadline<F: Future>(
    future: F,
    ticket: &DeadlineTicket,
    duration: Duration,
) -> Result<F::Output, PasskeyError> {
    match tokio::time::timeout(duration, future).await {
        Ok(result) => Ok(result),
        Err(_) => {
            ticket.retire();
            Err(PasskeyError::Unavailable)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(future)
    }

    #[test]
    fn missing_callback_settles_and_retires_before_a_queued_start() {
        let ticket = DeadlineTicket::new();
        let result = run(async {
            tokio::time::timeout(
                Duration::from_secs(1),
                await_deadline(std::future::pending::<()>(), &ticket, Duration::ZERO),
            )
            .await
        });
        assert!(matches!(result, Ok(Err(PasskeyError::Unavailable))));
        assert!(!ticket.active());
    }
    #[test]
    fn late_cleanup_and_callback_cannot_take_a_newer_ceremony() {
        let old = DeadlineTicket::new();
        let next = DeadlineTicket::new();
        let mut active = Some((old.clone(), "old"));
        assert!(old.retire());
        assert!(!old.retire());
        assert_eq!(take_owned(&mut active, &old), Some("old"));
        active = Some((next.clone(), "next"));
        assert_eq!(take_owned(&mut active, &old), None);
        assert!(next.active());
        assert_eq!(take_owned(&mut active, &next), Some("next"));
    }
    #[test]
    fn completed_callback_preserves_its_result_without_a_deadline_error() {
        let ticket = DeadlineTicket::new();
        assert_eq!(
            run(await_deadline(async { 7 }, &ticket, Duration::from_secs(1))),
            Ok(7)
        );
    }
}
