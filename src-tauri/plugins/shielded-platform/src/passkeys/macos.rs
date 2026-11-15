use std::cell::RefCell;

use futures_channel::oneshot;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, ProtocolObject};
use objc2::{define_class, msg_send, AnyThread, DefinedClass, MainThreadOnly};
use objc2_app_kit::NSWindow;
use objc2_authentication_services::*;
use objc2_foundation::{
    MainThreadMarker, NSArray, NSData, NSError, NSObject, NSObjectProtocol,
    NSOperatingSystemVersion, NSProcessInfo, NSString,
};
use tauri::{AppHandle, Runtime, WebviewWindow};
use zeroize::Zeroizing;

use super::{reply, PasskeyError, PasskeyRequest};

type Completion = Result<String, PasskeyError>;

struct DelegateState {
    window: Retained<NSWindow>,
    sender: RefCell<Option<oneshot::Sender<Completion>>>,
    create: bool,
}

struct Ceremony {
    delegate: Retained<ShieldedPasskeyDelegate>,
    _controller: Retained<ASAuthorizationController>,
}

thread_local! {
    static ACTIVE: RefCell<Option<Ceremony>> = const { RefCell::new(None) };
}

define_class!(
    #[unsafe(super = NSObject)]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateState]
    struct ShieldedPasskeyDelegate;

    unsafe impl NSObjectProtocol for ShieldedPasskeyDelegate {}

    unsafe impl ASAuthorizationControllerDelegate for ShieldedPasskeyDelegate {
        #[unsafe(method(authorizationController:didCompleteWithAuthorization:))]
        fn completed(
            &self,
            _controller: &ASAuthorizationController,
            authorization: &ASAuthorization,
        ) {
            let result = unsafe { response(authorization, self.ivars().create) };
            let _ceremony = self.finish(result);
        }

        #[unsafe(method(authorizationController:didCompleteWithError:))]
        fn failed(&self, _controller: &ASAuthorizationController, error: &NSError) {
            let domain = error.domain();
            let authorization_domain = &*domain == unsafe { ASAuthorizationErrorDomain };
            let result = Err(failure(authorization_domain, error.code()));
            let _ceremony = self.finish(result);
        }
    }

    unsafe impl ASAuthorizationControllerPresentationContextProviding for ShieldedPasskeyDelegate {
        #[unsafe(method_id(presentationAnchorForAuthorizationController:))]
        fn anchor(
            &self,
            _controller: &ASAuthorizationController,
        ) -> Retained<ASPresentationAnchor> {
            self.ivars().window.clone().into_super().into_super()
        }
    }
);

impl ShieldedPasskeyDelegate {
    fn new(mtm: MainThreadMarker, state: DelegateState) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(state);
        unsafe { msg_send![super(this), init] }
    }

    fn finish(&self, result: Completion) -> Option<Ceremony> {
        let sender = self.ivars().sender.borrow_mut().take();
        let ceremony = ACTIVE.with(|active| {
            let ours = active
                .borrow()
                .as_ref()
                .is_some_and(|item| std::ptr::eq::<ShieldedPasskeyDelegate>(&*item.delegate, self));
            if ours {
                active.borrow_mut().take()
            } else {
                None
            }
        });
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
        ceremony
    }
}

pub(crate) fn available() -> bool {
    NSProcessInfo::processInfo().isOperatingSystemAtLeastVersion(NSOperatingSystemVersion {
        majorVersion: 15,
        minorVersion: 0,
        patchVersion: 0,
    })
}

fn failure(authorization_domain: bool, code: isize) -> PasskeyError {
    if authorization_domain && code == ASAuthorizationError::Canceled.0 {
        PasskeyError::Cancelled
    } else {
        PasskeyError::Unavailable
    }
}

unsafe fn request_for(
    create: bool,
    input: PasskeyRequest,
) -> Result<Retained<ASAuthorizationRequest>, PasskeyError> {
    if !available() {
        return Err(PasskeyError::Unavailable);
    }
    let provider =
        ASAuthorizationPlatformPublicKeyCredentialProvider::initWithRelyingPartyIdentifier(
            ASAuthorizationPlatformPublicKeyCredentialProvider::alloc(),
            &NSString::from_str(&input.rp_id),
        );
    let challenge = NSData::with_bytes(&input.challenge);
    let required = ASAuthorizationPublicKeyCredentialUserVerificationPreferenceRequired
        .ok_or(PasskeyError::Unavailable)?;
    if create {
        let request = provider.createCredentialRegistrationRequestWithChallenge_name_userID(
            &challenge,
            &NSString::from_str(&input.user_name),
            &NSData::with_bytes(&input.user_id),
        );
        request.setUserVerificationPreference(required);
        request.setPrf(Some(
            &ASAuthorizationPublicKeyCredentialPRFRegistrationInput::checkForSupport(),
        ));
        Ok(request.into_super())
    } else {
        let request = provider.createCredentialAssertionRequestWithChallenge(&challenge);
        request.setUserVerificationPreference(required);
        let credentials: Vec<_> = input
            .credentials
            .iter()
            .map(|id| {
                ASAuthorizationPlatformPublicKeyCredentialDescriptor::initWithCredentialID(
                    ASAuthorizationPlatformPublicKeyCredentialDescriptor::alloc(),
                    &NSData::with_bytes(id),
                )
            })
            .collect();
        request.setAllowedCredentials(&NSArray::from_retained_slice(&credentials));
        // AuthenticationServices applies WebAuthn's PRF domain separation to the raw salt.
        let values = ASAuthorizationPublicKeyCredentialPRFAssertionInputValues::initWithSaltInput1_saltInput2(
            ASAuthorizationPublicKeyCredentialPRFAssertionInputValues::alloc(),
            &NSData::with_bytes(&input.salt),
            None,
        );
        let prf = ASAuthorizationPublicKeyCredentialPRFAssertionInput::initWithInputValues_perCredentialInputValues(
            ASAuthorizationPublicKeyCredentialPRFAssertionInput::alloc(),
            Some(&values),
            None,
        );
        request.setPrf(Some(&prf));
        Ok(request.into_super())
    }
}

unsafe fn response(authorization: &ASAuthorization, create: bool) -> Completion {
    let credential = authorization.credential();
    let object: &AnyObject = (&*credential).as_ref();
    if create {
        let registration = object
            .downcast_ref::<ASAuthorizationPlatformPublicKeyCredentialRegistration>()
            .ok_or(PasskeyError::Unavailable)?;
        let id = registration.credentialID().to_vec();
        let supported = registration.prf().is_some_and(|prf| prf.isSupported());
        reply(&id, None, None, Some(supported))
    } else {
        let assertion = object
            .downcast_ref::<ASAuthorizationPlatformPublicKeyCredentialAssertion>()
            .ok_or(PasskeyError::Unavailable)?;
        let id = assertion.credentialID().to_vec();
        let user = assertion.userID().to_vec();
        let prf = assertion
            .prf()
            .map(|value| Zeroizing::new(value.first().to_vec()));
        reply(&id, Some(&user), prf.as_deref().map(Vec::as_slice), None)
    }
}

fn begin<R: Runtime>(
    window: WebviewWindow<R>,
    create: bool,
    request: PasskeyRequest,
    sender: oneshot::Sender<Completion>,
) {
    if !available() || ACTIVE.with(|active| active.borrow().is_some()) {
        let _ = sender.send(Err(PasskeyError::Unavailable));
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        let _ = sender.send(Err(PasskeyError::Unavailable));
        return;
    };
    let native_window = window
        .ns_window()
        .ok()
        .and_then(|pointer| unsafe { Retained::<NSWindow>::retain(pointer.cast()) });
    let Some(native_window) = native_window else {
        let _ = sender.send(Err(PasskeyError::Unavailable));
        return;
    };
    let request = match unsafe { request_for(create, request) } {
        Ok(request) => request,
        Err(error) => {
            let _ = sender.send(Err(error));
            return;
        }
    };
    let delegate = ShieldedPasskeyDelegate::new(
        mtm,
        DelegateState {
            window: native_window,
            sender: RefCell::new(Some(sender)),
            create,
        },
    );
    unsafe {
        let controller = ASAuthorizationController::initWithAuthorizationRequests(
            ASAuthorizationController::alloc(),
            &NSArray::from_retained_slice(&[request]),
        );
        controller.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        controller.setPresentationContextProvider(Some(ProtocolObject::from_ref(&*delegate)));
        ACTIVE.with(|active| {
            *active.borrow_mut() = Some(Ceremony {
                delegate,
                _controller: controller.clone(),
            })
        });
        controller.performRequests();
    }
}

pub(crate) async fn run<R: Runtime>(
    app: AppHandle<R>,
    window: WebviewWindow<R>,
    create: bool,
    request: PasskeyRequest,
) -> Completion {
    if !available() {
        return Err(PasskeyError::Unavailable);
    }
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || begin(window, create, request, sender))
        .map_err(|_| PasskeyError::Unavailable)?;
    receiver.await.map_err(|_| PasskeyError::Unavailable)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_authorization_domain_cancellation_is_cancelled() {
        assert!(matches!(failure(true, 1001), PasskeyError::Cancelled));
        assert!(matches!(failure(false, 1001), PasskeyError::Unavailable));
        assert!(matches!(failure(true, 1004), PasskeyError::Unavailable));
    }

    #[test]
    fn assertion_passes_raw_salt_and_exact_credential_allow_list() {
        let input = PasskeyRequest {
            rp_id: "shielded.mutinynet.arkade.sh".into(),
            challenge: vec![8; 32],
            user_id: vec![],
            user_name: String::new(),
            salt: b"Default".to_vec(),
            credentials: vec![vec![2, 3]],
        };
        let request = unsafe { request_for(false, input) };
        if !available() {
            assert!(request.is_err());
            return;
        }
        let request = request.unwrap();
        let request = request
            .downcast_ref::<ASAuthorizationPlatformPublicKeyCredentialAssertionRequest>()
            .unwrap();
        unsafe {
            assert_eq!(
                request
                    .prf()
                    .unwrap()
                    .inputValues()
                    .unwrap()
                    .saltInput1()
                    .to_vec(),
                b"Default"
            );
            let credentials = request.allowedCredentials();
            assert_eq!(credentials.count(), 1);
            assert_eq!(
                credentials.objectAtIndex(0).credentialID().to_vec(),
                vec![2, 3]
            );
            assert_eq!(request.userVerificationPreference().to_string(), "required");
        }
    }
}
