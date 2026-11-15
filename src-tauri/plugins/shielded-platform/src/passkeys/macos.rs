use std::{cell::RefCell, time::Duration};

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

use super::{
    deadline::{await_deadline, take_owned, DeadlineTicket},
    reply, PasskeyError, PasskeyRequest,
};

type Completion = Result<String, PasskeyError>;

struct DelegateState {
    window: Retained<NSWindow>,
    sender: RefCell<Option<oneshot::Sender<Completion>>>,
    create: bool,
    ticket: DeadlineTicket,
}

struct Ceremony {
    delegate: Retained<ShieldedPasskeyDelegate>,
    controller: Retained<ASAuthorizationController>,
}

thread_local! {
    static ACTIVE: RefCell<Option<(DeadlineTicket, Ceremony)>> = const { RefCell::new(None) };
}

struct RetireOnDrop<F: FnOnce(DeadlineTicket)> {
    ticket: DeadlineTicket,
    cleanup: Option<F>,
}

impl<F: FnOnce(DeadlineTicket)> Drop for RetireOnDrop<F> {
    fn drop(&mut self) {
        self.ticket.retire();
        if let Some(cleanup) = self.cleanup.take() {
            cleanup(self.ticket.clone());
        }
    }
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
            let Some(_ceremony) = self.claim() else {
                return;
            };
            let result = if self.ivars().ticket.retire() {
                unsafe { response(authorization, self.ivars().create) }
            } else {
                Err(PasskeyError::Unavailable)
            };
            self.finish(result);
        }

        #[unsafe(method(authorizationController:didCompleteWithError:))]
        fn failed(&self, _controller: &ASAuthorizationController, error: &NSError) {
            let Some(_ceremony) = self.claim() else {
                return;
            };
            let result = if self.ivars().ticket.retire() {
                let domain = error.domain();
                let authorization_domain = &*domain == unsafe { ASAuthorizationErrorDomain };
                Err(failure(authorization_domain, error.code()))
            } else {
                Err(PasskeyError::Unavailable)
            };
            self.finish(result);
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

    fn claim(&self) -> Option<Ceremony> {
        ACTIVE.with(|active| take_owned(&mut *active.borrow_mut(), &self.ivars().ticket))
    }

    fn finish(&self, result: Completion) {
        let sender = self.ivars().sender.borrow_mut().take();
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }
}

fn cancel_owned(ticket: &DeadlineTicket) {
    let ceremony = ACTIVE.with(|active| take_owned(&mut *active.borrow_mut(), ticket));
    let Some(ceremony) = ceremony else {
        return;
    };
    unsafe {
        ceremony.controller.setDelegate(None);
        ceremony.controller.setPresentationContextProvider(None);
    }
    ceremony.delegate.finish(Err(PasskeyError::Unavailable));
    // Cancellation may synchronously invoke a delegate; the owner slot is already empty.
    unsafe {
        ceremony.controller.cancel();
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
    ticket: DeadlineTicket,
) {
    if !ticket.active() || !available() || ACTIVE.with(|active| active.borrow().is_some()) {
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
    if !ticket.active() {
        let _ = sender.send(Err(PasskeyError::Unavailable));
        return;
    }
    let delegate = ShieldedPasskeyDelegate::new(
        mtm,
        DelegateState {
            window: native_window,
            sender: RefCell::new(Some(sender)),
            create,
            ticket: ticket.clone(),
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
            *active.borrow_mut() = Some((
                ticket.clone(),
                Ceremony {
                    delegate,
                    controller: controller.clone(),
                },
            ))
        });
        if !ticket.active() {
            cancel_owned(&ticket);
            return;
        }
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
    let ticket = DeadlineTicket::new();
    let cleanup_app = app.clone();
    let _cleanup = RetireOnDrop {
        ticket: ticket.clone(),
        cleanup: Some(move |ticket| {
            let _ = cleanup_app.run_on_main_thread(move || cancel_owned(&ticket));
        }),
    };
    let (sender, receiver) = oneshot::channel();
    let queued = ticket.clone();
    await_deadline(
        async move {
            app.run_on_main_thread(move || begin(window, create, request, sender, queued))
                .map_err(|_| PasskeyError::Unavailable)?;
            receiver.await.map_err(|_| PasskeyError::Unavailable)?
        },
        &ticket,
        Duration::from_secs(120),
    )
    .await?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dropped_waiter_retires_queued_start_before_scheduling_cleanup() {
        use std::{
            cell::Cell,
            future::Future,
            rc::Rc,
            task::{Context, Waker},
        };
        let ticket = DeadlineTicket::new();
        let scheduled = Rc::new(Cell::new(false));
        let observed = scheduled.clone();
        let guard = RetireOnDrop {
            ticket: ticket.clone(),
            cleanup: Some(move |ticket: DeadlineTicket| {
                assert!(!ticket.active());
                observed.set(true);
            }),
        };
        let mut waiter = Box::pin(async move {
            let _guard = guard;
            std::future::pending::<()>().await;
        });
        let mut context = Context::from_waker(Waker::noop());
        assert!(waiter.as_mut().poll(&mut context).is_pending());
        assert!(ticket.active());
        drop(waiter);
        assert!(!ticket.active());
        assert!(scheduled.get());
    }

    #[test]
    fn delayed_drop_cleanup_preserves_a_newer_prompt() {
        use std::rc::Rc;
        let ticket = DeadlineTicket::new();
        let queued = Rc::new(RefCell::new(None));
        let cleanup_queue = queued.clone();
        drop(RetireOnDrop {
            ticket: ticket.clone(),
            cleanup: Some(move |ticket| *cleanup_queue.borrow_mut() = Some(ticket)),
        });
        let next = DeadlineTicket::new();
        let mut slot = Some((next.clone(), "next"));
        assert!(!ticket.active());
        assert!(take_owned(&mut slot, &queued.borrow_mut().take().unwrap()).is_none());
        assert!(next.active());
        assert_eq!(take_owned(&mut slot, &next), Some("next"));
    }

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
