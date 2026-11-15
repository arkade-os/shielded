use super::{reply, PasskeyError, PasskeyRequest};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use std::{ptr, sync::Mutex};
use windows::{
    core::{s, w, HRESULT, PCSTR, PCWSTR},
    Win32::{
        Foundation::*,
        Networking::WindowsWebServices::*,
        System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32},
    },
};
use zeroize::Zeroizing;

type Make = unsafe extern "system" fn(
    HWND,
    *const WEBAUTHN_RP_ENTITY_INFORMATION,
    *const WEBAUTHN_USER_ENTITY_INFORMATION,
    *const WEBAUTHN_COSE_CREDENTIAL_PARAMETERS,
    *const WEBAUTHN_CLIENT_DATA,
    *const WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS,
    *mut *mut WEBAUTHN_CREDENTIAL_ATTESTATION,
) -> HRESULT;
type Get = unsafe extern "system" fn(
    HWND,
    PCWSTR,
    *const WEBAUTHN_CLIENT_DATA,
    *const WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS,
    *mut *mut WEBAUTHN_ASSERTION,
) -> HRESULT;
type FreeRegistration = unsafe extern "system" fn(*const WEBAUTHN_CREDENTIAL_ATTESTATION);
type FreeAssertion = unsafe extern "system" fn(*const WEBAUTHN_ASSERTION);

static CEREMONY: Mutex<()> = Mutex::new(());

struct Library(HMODULE);
impl Library {
    unsafe fn symbol(
        &self,
        name: PCSTR,
    ) -> Result<unsafe extern "system" fn() -> isize, PasskeyError> {
        GetProcAddress(self.0, name).ok_or(PasskeyError::Unavailable)
    }
}
impl Drop for Library {
    fn drop(&mut self) {
        unsafe {
            let _ = FreeLibrary(self.0);
        }
    }
}
struct Api {
    _library: Library,
    make: Make,
    get: Get,
    free_registration: FreeRegistration,
    free_assertion: FreeAssertion,
}
impl Api {
    fn load() -> Result<Self, PasskeyError> {
        unsafe {
            let library = Library(
                LoadLibraryExW(w!("webauthn.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32)
                    .map_err(|_| PasskeyError::Unavailable)?,
            );
            let version: unsafe extern "system" fn() -> u32 =
                std::mem::transmute(library.symbol(s!("WebAuthNGetApiVersionNumber"))?);
            if version() < 6 {
                return Err(PasskeyError::Unavailable);
            }
            Ok(Self {
                make: std::mem::transmute(
                    library.symbol(s!("WebAuthNAuthenticatorMakeCredential"))?,
                ),
                get: std::mem::transmute(library.symbol(s!("WebAuthNAuthenticatorGetAssertion"))?),
                free_registration: std::mem::transmute(
                    library.symbol(s!("WebAuthNFreeCredentialAttestation"))?,
                ),
                free_assertion: std::mem::transmute(library.symbol(s!("WebAuthNFreeAssertion"))?),
                _library: library,
            })
        }
    }
}

struct Registration<'a>(*mut WEBAUTHN_CREDENTIAL_ATTESTATION, &'a Api);
impl Drop for Registration<'_> {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                (self.1.free_registration)(self.0);
            }
        }
    }
}
struct Assertion<'a>(*mut WEBAUTHN_ASSERTION, &'a Api);
impl Drop for Assertion<'_> {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                (self.1.free_assertion)(self.0);
            }
        }
    }
}

pub(crate) fn available() -> bool {
    Api::load().is_ok()
}

fn creation_options() -> WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
    WEBAUTHN_AUTHENTICATOR_MAKE_CREDENTIAL_OPTIONS {
        dwVersion: 6,
        dwTimeoutMilliseconds: 90_000,
        dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
        bRequireResidentKey: true.into(),
        dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
        dwAttestationConveyancePreference: WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE,
        bEnablePrf: true.into(),
        ..Default::default()
    }
}
fn assertion_options(
    values: &mut WEBAUTHN_HMAC_SECRET_SALT_VALUES,
    credentials: WEBAUTHN_CREDENTIALS,
) -> WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
    WEBAUTHN_AUTHENTICATOR_GET_ASSERTION_OPTIONS {
        dwVersion: 6,
        dwTimeoutMilliseconds: 90_000,
        CredentialList: credentials,
        dwAuthenticatorAttachment: WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY,
        dwUserVerificationRequirement: WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED,
        // With this flag unset, Windows applies WebAuthn's PRF domain separation.
        dwFlags: 0,
        pHmacSecretSaltValues: values,
        ..Default::default()
    }
}
fn prf_salt(salt: &mut [u8]) -> WEBAUTHN_HMAC_SECRET_SALT {
    WEBAUTHN_HMAC_SECRET_SALT {
        cbFirst: salt.len() as u32,
        pbFirst: salt.as_mut_ptr(),
        ..Default::default()
    }
}
fn client_json(input: &PasskeyRequest, create: bool) -> Result<Vec<u8>, PasskeyError> {
    serde_json::to_vec(&serde_json::json!({
        "type": if create { "webauthn.create" } else { "webauthn.get" },
        "challenge": URL_SAFE_NO_PAD.encode(&input.challenge),
        "origin": format!("https://{}", input.rp_id),
        "crossOrigin": false,
    }))
    .map_err(|_| PasskeyError::Unavailable)
}
fn failure(error: HRESULT) -> PasskeyError {
    if [
        NTE_USER_CANCELLED,
        NTE_DEVICE_NOT_FOUND,
        NTE_NOT_FOUND,
        HRESULT::from_win32(ERROR_CANCELLED.0),
        HRESULT::from_win32(ERROR_TIMEOUT.0),
    ]
    .contains(&error)
    {
        PasskeyError::Cancelled
    } else {
        PasskeyError::Unavailable
    }
}

unsafe fn output(pointer: *const u8, length: u32, max: u32) -> Result<Vec<u8>, PasskeyError> {
    if pointer.is_null() || length == 0 || length > max {
        return Err(PasskeyError::Unavailable);
    }
    Ok(std::slice::from_raw_parts(pointer, length as usize).to_vec())
}
unsafe fn registration_reply(
    result: *const WEBAUTHN_CREDENTIAL_ATTESTATION,
) -> Result<String, PasskeyError> {
    if result.is_null() || result.cast::<u32>().read() < 5 {
        return Err(PasskeyError::Unavailable);
    }
    let id = output(
        ptr::addr_of!((*result).pbCredentialId).read(),
        ptr::addr_of!((*result).cbCredentialId).read(),
        4096,
    )?;
    let enabled = ptr::addr_of!((*result).bPrfEnabled).read().as_bool();
    reply(&id, None, None, Some(enabled))
}
unsafe fn assertion_reply(result: *const WEBAUTHN_ASSERTION) -> Result<String, PasskeyError> {
    if result.is_null() || result.cast::<u32>().read() < 3 {
        return Err(PasskeyError::Unavailable);
    }
    let prf = ptr::addr_of!((*result).pHmacSecret).read();
    if prf.is_null() || ptr::addr_of!((*prf).cbFirst).read() != 32 {
        return Err(PasskeyError::Unavailable);
    }
    let secret = Zeroizing::new(output(ptr::addr_of!((*prf).pbFirst).read(), 32, 32)?);
    let id = output(
        ptr::addr_of!((*result).Credential.pbId).read(),
        ptr::addr_of!((*result).Credential.cbId).read(),
        4096,
    )?;
    let user_length = ptr::addr_of!((*result).cbUserId).read();
    let user = if user_length == 0 {
        None
    } else {
        Some(output(
            ptr::addr_of!((*result).pbUserId).read(),
            user_length,
            64,
        )?)
    };
    reply(&id, user.as_deref(), Some(&secret), Some(true))
}

pub(crate) fn run(
    hwnd: isize,
    create: bool,
    mut input: PasskeyRequest,
) -> Result<String, PasskeyError> {
    let _ceremony = CEREMONY.try_lock().map_err(|_| PasskeyError::Unavailable)?;
    if hwnd == 0 {
        return Err(PasskeyError::Unavailable);
    }
    let api = Api::load()?;
    let rp: Vec<u16> = input.rp_id.encode_utf16().chain(Some(0)).collect();
    let name: Vec<u16> = input.user_name.encode_utf16().chain(Some(0)).collect();
    let mut json = client_json(&input, create)?;
    let client = WEBAUTHN_CLIENT_DATA {
        dwVersion: 1,
        cbClientDataJSON: json.len() as u32,
        pbClientDataJSON: json.as_mut_ptr(),
        pwszHashAlgId: WEBAUTHN_HASH_ALGORITHM_SHA_256,
    };
    let hwnd = HWND(hwnd as *mut _);
    if create {
        let rp = WEBAUTHN_RP_ENTITY_INFORMATION {
            dwVersion: 1,
            pwszId: PCWSTR(rp.as_ptr()),
            pwszName: w!("Shielded"),
            ..Default::default()
        };
        let user = WEBAUTHN_USER_ENTITY_INFORMATION {
            dwVersion: 1,
            cbId: input.user_id.len() as u32,
            pbId: input.user_id.as_mut_ptr(),
            pwszName: PCWSTR(name.as_ptr()),
            pwszDisplayName: PCWSTR(name.as_ptr()),
            ..Default::default()
        };
        let mut algorithms = [-7, -257].map(|algorithm| WEBAUTHN_COSE_CREDENTIAL_PARAMETER {
            dwVersion: 1,
            pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
            lAlg: algorithm,
        });
        let algorithms = WEBAUTHN_COSE_CREDENTIAL_PARAMETERS {
            cCredentialParameters: algorithms.len() as u32,
            pCredentialParameters: algorithms.as_mut_ptr(),
        };
        let mut result = ptr::null_mut();
        let error = unsafe {
            (api.make)(
                hwnd,
                &rp,
                &user,
                &algorithms,
                &client,
                &creation_options(),
                &mut result,
            )
        };
        let result = Registration(result, &api);
        if error.is_err() {
            return Err(failure(error));
        }
        unsafe { registration_reply(result.0) }
    } else {
        let mut credentials: Vec<_> = input
            .credentials
            .iter_mut()
            .map(|id| WEBAUTHN_CREDENTIAL {
                dwVersion: 1,
                cbId: id.len() as u32,
                pbId: id.as_mut_ptr(),
                pwszCredentialType: WEBAUTHN_CREDENTIAL_TYPE_PUBLIC_KEY,
            })
            .collect();
        let credentials = WEBAUTHN_CREDENTIALS {
            cCredentials: credentials.len() as u32,
            pCredentials: if credentials.is_empty() {
                ptr::null_mut()
            } else {
                credentials.as_mut_ptr()
            },
        };
        let mut salt = prf_salt(&mut input.salt);
        let mut values = WEBAUTHN_HMAC_SECRET_SALT_VALUES {
            pGlobalHmacSalt: &mut salt,
            ..Default::default()
        };
        let options = assertion_options(&mut values, credentials);
        let mut result = ptr::null_mut();
        let error = unsafe { (api.get)(hwnd, PCWSTR(rp.as_ptr()), &client, &options, &mut result) };
        let result = Assertion(result, &api);
        if error.is_err() {
            return Err(failure(error));
        }
        unsafe { assertion_reply(result.0) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> PasskeyRequest {
        PasskeyRequest {
            rp_id: "shielded.mutinynet.arkade.sh".into(),
            challenge: vec![7; 32],
            user_id: vec![3; 32],
            user_name: "Shielded wallet".into(),
            salt: b"Default".to_vec(),
            credentials: vec![vec![1, 2, 3]],
        }
    }

    #[test]
    fn creation_requires_resident_verified_prf_without_restricting_provider() {
        let options = creation_options();
        assert_eq!(options.dwVersion, 6);
        assert!(options.bRequireResidentKey.as_bool());
        assert!(!options.bPreferResidentKey.as_bool());
        assert!(options.bEnablePrf.as_bool());
        assert_eq!(
            options.dwUserVerificationRequirement,
            WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED
        );
        assert_eq!(
            options.dwAuthenticatorAttachment,
            WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY
        );
        assert_eq!(
            options.dwAttestationConveyancePreference,
            WEBAUTHN_ATTESTATION_CONVEYANCE_PREFERENCE_NONE
        );
    }

    #[test]
    fn assertion_passes_raw_salt_with_windows_web_authn_hashing() {
        let mut input = request();
        let mut salt = prf_salt(&mut input.salt);
        let mut values = WEBAUTHN_HMAC_SECRET_SALT_VALUES {
            pGlobalHmacSalt: &mut salt,
            ..Default::default()
        };
        let options = assertion_options(&mut values, WEBAUTHN_CREDENTIALS::default());
        assert_eq!(options.dwVersion, 6);
        assert_eq!(
            options.dwFlags & WEBAUTHN_AUTHENTICATOR_HMAC_SECRET_VALUES_FLAG,
            0
        );
        assert_eq!(
            options.dwUserVerificationRequirement,
            WEBAUTHN_USER_VERIFICATION_REQUIREMENT_REQUIRED
        );
        assert_eq!(
            options.dwAuthenticatorAttachment,
            WEBAUTHN_AUTHENTICATOR_ATTACHMENT_ANY
        );
        assert_eq!(
            unsafe { std::slice::from_raw_parts(salt.pbFirst, salt.cbFirst as usize) },
            b"Default"
        );
        assert!(salt.pbSecond.is_null());
    }

    #[test]
    fn challenge_is_base64url_and_origin_is_canonical() {
        let input = request();
        let json: serde_json::Value =
            serde_json::from_slice(&client_json(&input, false).unwrap()).unwrap();
        assert_eq!(json["type"], "webauthn.get");
        assert_eq!(json["origin"], "https://shielded.mutinynet.arkade.sh");
        assert_eq!(json["challenge"], URL_SAFE_NO_PAD.encode(&input.challenge));
        assert_eq!(json["crossOrigin"], false);
    }

    #[test]
    fn truncated_results_are_rejected_before_later_fields_are_read() {
        let version = 1u32;
        assert!(unsafe { registration_reply((&version as *const u32).cast()) }.is_err());
        assert!(unsafe { assertion_reply((&version as *const u32).cast()) }.is_err());
        assert!(unsafe { assertion_reply(std::ptr::null()) }.is_err());
    }

    #[test]
    fn windows_cancellation_is_sanitized() {
        assert!(matches!(
            failure(NTE_USER_CANCELLED),
            PasskeyError::Cancelled
        ));
        assert!(matches!(
            failure(HRESULT::from_win32(ERROR_CANCELLED.0)),
            PasskeyError::Cancelled
        ));
        assert!(matches!(
            failure(HRESULT(0x80004005u32 as i32)),
            PasskeyError::Unavailable
        ));
    }

    #[test]
    fn output_requires_a_complete_prf_and_returns_credential_and_user_handle() {
        let mut id = [1u8, 2, 3];
        let mut user = [0x53u8, 0x4b, 0x12];
        let mut secret = [5u8; 32];
        let mut prf = WEBAUTHN_HMAC_SECRET_SALT {
            cbFirst: 31,
            pbFirst: secret.as_mut_ptr(),
            ..Default::default()
        };
        let result = WEBAUTHN_ASSERTION {
            dwVersion: 3,
            Credential: WEBAUTHN_CREDENTIAL {
                cbId: id.len() as u32,
                pbId: id.as_mut_ptr(),
                ..Default::default()
            },
            cbUserId: user.len() as u32,
            pbUserId: user.as_mut_ptr(),
            pHmacSecret: &mut prf,
            ..Default::default()
        };
        assert!(unsafe { assertion_reply(&result) }.is_err());
        unsafe {
            (*result.pHmacSecret).cbFirst = 32;
        }
        let json: serde_json::Value =
            serde_json::from_str(&unsafe { assertion_reply(&result) }.unwrap()).unwrap();
        assert_eq!(json["rawId"], URL_SAFE_NO_PAD.encode(id));
        assert_eq!(json["response"]["userHandle"], URL_SAFE_NO_PAD.encode(user));
        assert_eq!(
            json["clientExtensionResults"]["prf"]["results"]["first"],
            URL_SAFE_NO_PAD.encode(secret)
        );
    }

    #[test]
    fn registration_reports_unsupported_prf_instead_of_inventing_a_secret() {
        let mut id = [4u8, 5, 6];
        let mut result = WEBAUTHN_CREDENTIAL_ATTESTATION {
            dwVersion: 5,
            cbCredentialId: id.len() as u32,
            pbCredentialId: id.as_mut_ptr(),
            bPrfEnabled: false.into(),
            ..Default::default()
        };
        let json: serde_json::Value =
            serde_json::from_str(&unsafe { registration_reply(&result) }.unwrap()).unwrap();
        assert_eq!(json["rawId"], URL_SAFE_NO_PAD.encode(id));
        assert_eq!(json["clientExtensionResults"]["prf"]["enabled"], false);
        result.cbCredentialId = 4097;
        assert!(unsafe { registration_reply(&result) }.is_err());
        result.cbCredentialId = 0;
        assert!(unsafe { registration_reply(&result) }.is_err());
    }
}
