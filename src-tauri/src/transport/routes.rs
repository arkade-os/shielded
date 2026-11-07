use super::policy::CheckedRequest;
use sha2::{Digest, Sha256};

pub const POOL: &str = "shielded.mutinynet.arkade.sh";
const ARK: &str = "mutinynet.arkade.sh";
const ESPLORA: &str = "mempool.mutinynet.arkade.sh";

fn hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn number(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
}
fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}
fn script(value: &str) -> bool {
    !value.is_empty() && value.len() % 2 == 0 && hex(value, value.len())
}
fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn query_allowed(checked: &CheckedRequest, names: &[&str]) -> bool {
    let mut seen = std::collections::HashSet::new();
    checked
        .url
        .query_pairs()
        .all(|(name, _)| names.contains(&name.as_ref()) && seen.insert(name.into_owned()))
}
fn object(checked: &CheckedRequest) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    serde_json::from_slice::<serde_json::Value>(&checked.body)
        .map_err(|_| "private route requires JSON object")?
        .as_object()
        .cloned()
        .ok_or_else(|| "private route requires JSON object".into())
}

pub fn binding(
    purpose: &str,
    checked: &CheckedRequest,
    subscription: Option<&str>,
) -> Result<String, String> {
    let host = checked.url.host_str().ok_or("missing private route host")?;
    let path = checked.url.path();
    if path.contains('%') || path.contains('\\') || path.contains("//") {
        return Err("encoded private route is not approved".into());
    }
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let get = checked.method == hyper::Method::GET;
    let post = checked.method == hyper::Method::POST;
    let denied = || Err("private scope does not permit this route or item".into());
    if ["lnurl", "swap", "discovery"].contains(&purpose) {
        if [POOL, ARK, ESPLORA].contains(&host) {
            return denied();
        }
        return Ok(format!(
            "dynamic|{}",
            checked.url.origin().ascii_serialization()
        ));
    }
    if host == POOL && parts.starts_with(&["api", "rollup"]) {
        let suffix = &parts[2..];
        if !query_allowed(
            checked,
            if purpose == "pool-sync" && matches!(suffix, ["batches"]) {
                &["from", "limit"]
            } else if purpose == "assets" {
                &["v"]
            } else {
                &[]
            },
        ) {
            return denied();
        }
        match (purpose, suffix) {
            ("public", ["status" | "assets" | "archives" | "times"]) if get => {
                return Ok(path.into());
            }
            ("pool-sync", ["batches" | "status" | "archives" | "times"]) if get => {
                return Ok("pool-sync".into());
            }
            ("pool-sync", ["checkpoints", epoch, batch])
                if get && number(epoch) && number(batch) =>
            {
                return Ok("pool-sync".into());
            }
            ("assets", ["proving", file])
                if get
                    && [
                        "epoch-spend.wasm",
                        "epoch-spend.zkey",
                        "epoch-join.wasm",
                        "epoch-join.zkey",
                    ]
                    .contains(file) =>
            {
                if checked.url.query_pairs().any(|(_, value)| !hex(&value, 64)) {
                    return denied();
                }
                return Ok("proving".into());
            }
            ("pool-operation", ["spends"]) if post => {
                let body = object(checked)?;
                let id = body
                    .get("id")
                    .and_then(|v| v.as_str())
                    .filter(|id| hex(id, 32))
                    .ok_or("private spend requires durable identifier")?;
                return Ok(format!("spend|{id}"));
            }
            ("pool-operation", ["spends", id]) if get && hex(id, 32) => {
                return Ok(format!("spend|{id}"));
            }
            ("pool-operation", ["spends", id, "sign"]) if post && hex(id, 32) => {
                return Ok(format!("spend|{id}"));
            }
            ("pool-operation", ["assets"]) if post => {
                return Ok(format!("asset|{}", digest(&checked.body)));
            }
            _ => return denied(),
        }
    }
    if host == ARK {
        if purpose == "public" && get && path == "/v1/info" && query_allowed(checked, &[]) {
            return Ok(path.into());
        }
        if purpose == "indexer" && parts.starts_with(&["v1", "indexer"]) {
            let suffix = &parts[2..];
            match suffix {
                ["vtxos"] if get => {
                    let pairs: Vec<_> = checked.url.query_pairs().collect();
                    if pairs.iter().any(|(name, _)| {
                        ![
                            "scripts",
                            "outpoints",
                            "spendableOnly",
                            "spentOnly",
                            "recoverableOnly",
                            "pendingOnly",
                            "renewableOnly",
                            "after",
                            "before",
                            "page.index",
                            "page.size",
                        ]
                        .contains(&name.as_ref())
                    }) {
                        return denied();
                    }
                    let mut seen = std::collections::HashSet::new();
                    if pairs.iter().any(|(name, _)| !seen.insert(name.as_ref())) {
                        return denied();
                    }
                    let items: Vec<_> = pairs
                        .iter()
                        .filter(|(name, _)| name == "scripts" || name == "outpoints")
                        .collect();
                    if items.len() != 1 {
                        return denied();
                    }
                    let (kind, value) = items[0];
                    let valid = if kind == "scripts" {
                        script(value)
                    } else {
                        value.split_once(':').is_some_and(|(txid, vout)| {
                            hex(txid, 64) && vout.parse::<u32>().is_ok()
                        })
                    };
                    if !valid {
                        return denied();
                    }
                    return Ok(format!("{kind}|{value}"));
                }
                ["script", "subscribe"] if post && query_allowed(checked, &[]) => {
                    let body = object(checked)?;
                    if body.keys().any(|key| key != "scripts") {
                        return denied();
                    }
                    let scripts = body
                        .get("scripts")
                        .and_then(|v| v.as_array())
                        .ok_or("private subscription requires one script")?;
                    if scripts.len() != 1 {
                        return denied();
                    }
                    let script_value = scripts[0]
                        .as_str()
                        .filter(|value| script(value))
                        .ok_or("invalid private subscription script")?;
                    return Ok(format!("scripts|{script_value}"));
                }
                ["script", "subscription", id]
                    if get
                        && Some(*id) == subscription
                        && identifier(id)
                        && query_allowed(checked, &[]) =>
                {
                    return Ok("subscription".into());
                }
                ["script", "unsubscribe"] if post && query_allowed(checked, &[]) => {
                    let body = object(checked)?;
                    if body
                        .keys()
                        .any(|key| !["scripts", "subscriptionId"].contains(&key.as_str()))
                        || body.get("subscriptionId").and_then(|v| v.as_str()) != subscription
                        || subscription.is_none()
                    {
                        return denied();
                    }
                    if let Some(scripts) = body.get("scripts") {
                        let scripts = scripts
                            .as_array()
                            .ok_or("invalid private unsubscribe scripts")?;
                        if scripts.len() != 1 || !scripts[0].as_str().is_some_and(script) {
                            return denied();
                        }
                        return Ok(format!(
                            "scripts|{}",
                            scripts[0]
                                .as_str()
                                .ok_or("invalid private unsubscribe script")?
                        ));
                    }
                    return Ok("subscription".into());
                }
                ["virtualTx", txid] if get && hex(txid, 64) => return Ok(path.into()),
                ["batch", txid, index, "tree" | "sweepTxs"]
                    if get && hex(txid, 64) && number(index) =>
                {
                    return Ok(path.into());
                }
                ["batch", txid, index, "tree", "leaves"]
                    if get && hex(txid, 64) && number(index) =>
                {
                    return Ok(path.into());
                }
                ["commitmentTx", txid] | ["commitmentTx", txid, "connectors" | "forfeitTxs"]
                    if get && hex(txid, 64) =>
                {
                    return Ok(path.into());
                }
                ["vtxo", txid, index, "chain"] if get && hex(txid, 64) && number(index) => {
                    return Ok(path.into());
                }
                ["asset", asset] if get && identifier(asset) => return Ok(path.into()),
                _ => return denied(),
            }
        }
        if purpose == "ark" {
            if get
                && path == "/v1/batch/events"
                && checked.url.query_pairs().all(|(name, _)| name == "topics")
            {
                return Ok(format!("events|{}", checked.url.query().unwrap_or("")));
            }
            if post
                && query_allowed(checked, &[])
                && [
                    "/v1/tx/submit",
                    "/v1/tx/finalize",
                    "/v1/tx/pending",
                    "/v1/batch/registerIntent",
                    "/v1/batch/deleteIntent",
                    "/v1/batch/ack",
                    "/v1/batch/tree/submitNonces",
                    "/v1/batch/tree/submitSignatures",
                    "/v1/batch/submitForfeitTxs",
                ]
                .contains(&path)
            {
                return Ok(format!("{path}|{}", digest(&checked.body)));
            }
        }
    }
    if host == ESPLORA && parts.first() == Some(&"api") {
        if !query_allowed(checked, &[]) {
            return denied();
        }
        let suffix = &parts[1..];
        if purpose == "public"
            && get
            && [
                "/api/fee-estimates",
                "/api/v1/fees/recommended",
                "/api/blocks",
                "/api/v1/blocks",
            ]
            .contains(&path)
        {
            return Ok(path.into());
        }
        if purpose == "esplora" {
            match suffix {
                ["address", address] | ["address", address, "utxo" | "txs"]
                    if get && identifier(address) =>
                {
                    return Ok(format!("address|{address}"));
                }
                ["tx", txid] | ["tx", txid, "hex" | "status" | "outspends"]
                    if get && hex(txid, 64) =>
                {
                    return Ok(format!("tx|{txid}"));
                }
                ["tx", txid, "outspend", index] if get && hex(txid, 64) && number(index) => {
                    return Ok(format!("tx|{txid}"));
                }
                ["tx"] | ["txs", "package"] if post => {
                    return Ok(format!("broadcast|{}", digest(&checked.body)));
                }
                _ => return denied(),
            }
        }
    }
    denied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{NativeRequest, policy::check_request};
    use base64::{Engine, engine::general_purpose::STANDARD};

    fn checked(url: &str, body: Option<&str>) -> CheckedRequest {
        check_request(
            &NativeRequest {
                generation: 1,
                request_id: "test".into(),
                scope: "scope".into(),
                url: url.into(),
                method: if body.is_some() { "POST" } else { "GET" }.into(),
                headers: vec![],
                body_base64: body.map(|body| STANDARD.encode(body)),
            },
            false,
        )
        .unwrap()
    }

    #[test]
    fn purpose_cannot_escape_pinned_service_or_relabel_protected_routes() {
        assert!(binding("public", &checked("https://example.org/", None), None).is_err());
        for purpose in ["public", "lnurl", "swap", "discovery", "ark"] {
            assert!(
                binding(
                    purpose,
                    &checked(
                        "https://mutinynet.arkade.sh/v1/indexer/vtxos?scripts=aa",
                        None
                    ),
                    None
                )
                .is_err()
            );
        }
        assert!(
            binding(
                "public",
                &checked(
                    "https://shielded.mutinynet.arkade.sh/api/rollup/status",
                    None
                ),
                None
            )
            .is_ok()
        );
        assert!(
            binding(
                "discovery",
                &checked("https://check.torproject.org/api/ip", None),
                None
            )
            .is_ok()
        );
    }

    #[test]
    fn grouped_indexer_reads_and_subscriptions_are_rejected() {
        assert!(
            binding(
                "indexer",
                &checked(
                    "https://mutinynet.arkade.sh/v1/indexer/vtxos?scripts=aa&scripts=bb",
                    None
                ),
                None
            )
            .is_err()
        );
        assert!(
            binding(
                "indexer",
                &checked(
                    "https://mutinynet.arkade.sh/v1/indexer/vtxos?scripts=aa,bb",
                    None
                ),
                None
            )
            .is_err()
        );
        assert!(
            binding(
                "indexer",
                &checked(
                    "https://mutinynet.arkade.sh/v1/indexer/script/subscribe",
                    Some(r#"{"scripts":["aa","bb"]}"#)
                ),
                None
            )
            .is_err()
        );
        assert_eq!(
            binding(
                "indexer",
                &checked(
                    "https://mutinynet.arkade.sh/v1/indexer/script/subscribe",
                    Some(r#"{"scripts":["aa"]}"#)
                ),
                None
            )
            .unwrap(),
            "scripts|aa"
        );
        assert!(
            binding(
                "indexer",
                &checked(
                    "https://mutinynet.arkade.sh/v1/indexer/script/subscription/forged",
                    None
                ),
                Some("real")
            )
            .is_err()
        );
    }

    #[test]
    fn emitted_wallet_urls_match_the_native_policy() {
        let txid = "ab".repeat(32);
        for (purpose, url) in [
            (
                "assets",
                format!("https://{POOL}/api/rollup/proving/epoch-spend.zkey?v={txid}"),
            ),
            ("pool-sync", format!("https://{POOL}/api/rollup/status")),
            (
                "pool-sync",
                format!("https://{POOL}/api/rollup/batches?from=100&limit=100"),
            ),
            (
                "indexer",
                format!(
                    "https://{ARK}/v1/indexer/vtxos?scripts=5120{txid}&spendableOnly=true&spentOnly=false&recoverableOnly=true&pendingOnly=false&renewableOnly=false&after=0&before=0&page.index=1&page.size=50"
                ),
            ),
            (
                "indexer",
                format!(
                    "https://{ARK}/v1/indexer/vtxos?outpoints={txid}%3A0&page.index=0&page.size=50"
                ),
            ),
            (
                "indexer",
                format!("https://{ARK}/v1/indexer/virtualTx/{txid}"),
            ),
            ("public", format!("https://{ESPLORA}/api/fee-estimates")),
            (
                "esplora",
                format!("https://{ESPLORA}/api/address/tb1qaddress/utxo"),
            ),
            ("esplora", format!("https://{ESPLORA}/api/tx/{txid}/status")),
        ] {
            assert!(
                binding(purpose, &checked(&url, None), None).is_ok(),
                "{purpose}: {url}"
            );
        }
        assert!(
            binding(
                "assets",
                &checked(
                    &format!("https://{POOL}/api/rollup/proving/epoch-join.wasm?v=unique-tracker"),
                    None
                ),
                None
            )
            .is_err()
        );
        assert!(
            binding(
                "pool-sync",
                &checked(
                    &format!("https://{POOL}/api/rollup/scan?from=1&limit=1"),
                    None
                ),
                None
            )
            .is_err()
        );
        assert!(
            binding(
                "public",
                &checked("https://mutinynet.arkade.sh/v1/info?item=hidden", None),
                None
            )
            .is_err()
        );
    }
}
