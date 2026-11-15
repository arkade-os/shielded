use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};

#[cfg(any(target_os = "macos", test))]
mod deadline;

#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(target_os = "windows")]
pub(crate) mod windows;

#[derive(Debug, PartialEq)]
pub(super) enum PasskeyError {
    Cancelled,
    Unavailable,
}
impl From<PasskeyError> for String {
    fn from(error: PasskeyError) -> Self {
        match error {
            PasskeyError::Cancelled => "Passkey cancelled",
            PasskeyError::Unavailable => "Passkey unavailable",
        }
        .into()
    }
}

pub(super) struct PasskeyRequest {
    pub rp_id: String,
    pub challenge: Vec<u8>,
    pub user_id: Vec<u8>,
    pub user_name: String,
    pub salt: Vec<u8>,
    pub credentials: Vec<Vec<u8>>,
}
const RP: &str = "shielded.mutinynet.arkade.sh";
fn bytes(value: &Value, min: usize, max: usize) -> Result<Vec<u8>, PasskeyError> {
    let value = value.as_str().ok_or(PasskeyError::Unavailable)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| PasskeyError::Unavailable)?;
    if !(min..=max).contains(&decoded.len()) {
        return Err(PasskeyError::Unavailable);
    }
    Ok(decoded)
}
pub(super) fn parse(request: &str, create: bool) -> Result<PasskeyRequest, PasskeyError> {
    let fail = || PasskeyError::Unavailable;
    if request.len() > 65536 {
        return Err(fail());
    }
    let value: Value = serde_json::from_str(request).map_err(|_| fail())?;
    let rp_id = if create {
        &value["rp"]["id"]
    } else {
        &value["rpId"]
    };
    if rp_id.as_str() != Some(RP) {
        return Err(fail());
    }
    let challenge = bytes(&value["challenge"], 32, 32)?;
    let salt = bytes(&value["extensions"]["prf"]["eval"]["first"], 1, 1024)?;
    if value["extensions"]["prf"]["eval"].get("second").is_some() {
        return Err(fail());
    }
    let verification = if create {
        &value["authenticatorSelection"]["userVerification"]
    } else {
        &value["userVerification"]
    };
    if verification.as_str() != Some("required") {
        return Err(fail());
    }
    let mut user_id = vec![];
    let mut user_name = String::new();
    let mut credentials = vec![];
    if create {
        if value["authenticatorSelection"]["residentKey"].as_str() != Some("required")
            || !value["pubKeyCredParams"]
                .as_array()
                .ok_or_else(fail)?
                .iter()
                .any(|p| p["type"] == "public-key" && p["alg"] == -7)
            || value
                .get("excludeCredentials")
                .is_some_and(|v| v.as_array().is_none_or(|a| !a.is_empty()))
        {
            return Err(fail());
        }
        user_id = bytes(&value["user"]["id"], 1, 64)?;
        let name = value["user"]["name"].as_str().ok_or_else(fail)?;
        if name.is_empty() || name.len() > 256 || name.contains('\0') {
            return Err(fail());
        }
        user_name = name.to_owned();
    } else if let Some(allowed) = value.get("allowCredentials") {
        let allowed = allowed.as_array().ok_or_else(fail)?;
        if allowed.len() > 32 {
            return Err(fail());
        }
        for credential in allowed {
            if credential["type"] != "public-key" {
                return Err(fail());
            }
            credentials.push(bytes(&credential["id"], 1, 1024)?);
        }
    }
    Ok(PasskeyRequest {
        rp_id: RP.into(),
        challenge,
        user_id,
        user_name,
        salt,
        credentials,
    })
}
pub(super) fn reply(
    id: &[u8],
    user: Option<&[u8]>,
    prf: Option<&[u8]>,
    enabled: Option<bool>,
) -> Result<String, PasskeyError> {
    if id.is_empty()
        || id.len() > 1024
        || user.is_some_and(|u| u.len() > 64)
        || prf.is_some_and(|p| p.len() != 32)
    {
        return Err(PasskeyError::Unavailable);
    }
    let id = URL_SAFE_NO_PAD.encode(id);
    let mut extension = json!({});
    if let Some(enabled) = enabled {
        extension["enabled"] = json!(enabled);
    }
    if let Some(prf) = prf {
        extension["results"] = json!({"first":URL_SAFE_NO_PAD.encode(prf)});
    }
    Ok(json!({"id":id,"rawId":id,"type":"public-key","response":{"userHandle":user.map(|u|URL_SAFE_NO_PAD.encode(u))},"clientExtensionResults":{"prf":extension}}).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_requests_keep_raw_web_authn_salt_and_restrict_the_rp() {
        let mut input = json!({"rpId":RP,"challenge":URL_SAFE_NO_PAD.encode([0;32]),"extensions":{"prf":{"eval":{"first":URL_SAFE_NO_PAD.encode(b"Default")}}},"userVerification":"required"});
        assert_eq!(parse(&input.to_string(), false).unwrap().salt, b"Default");
        input["rpId"] = json!("tauri.localhost");
        assert!(parse(&input.to_string(), false).is_err());
    }
    #[test]
    fn native_credentials_enforce_the_provider_limit_independently_of_public_metadata() {
        let mut input = json!({"rpId":RP,"challenge":URL_SAFE_NO_PAD.encode([0;32]),"extensions":{"prf":{"eval":{"first":URL_SAFE_NO_PAD.encode(b"Default")}}},"userVerification":"required"});
        for (length, accepted) in [(1024, true), (1025, false)] {
            input["allowCredentials"] =
                json!([{"type":"public-key","id":URL_SAFE_NO_PAD.encode(vec![1;length])}]);
            assert_eq!(parse(&input.to_string(), false).is_ok(), accepted);
        }
    }
    #[test]
    fn native_responses_reject_incomplete_prf_output() {
        assert!(reply(&[1], None, Some(&[0; 31]), None).is_err());
        assert!(reply(&[], None, Some(&[0; 32]), None).is_err());
        let output: Value =
            serde_json::from_str(&reply(&[1], Some(&[2]), Some(&[0; 32]), None).unwrap()).unwrap();
        assert_eq!(output["response"]["userHandle"], "Ag");
    }
}
