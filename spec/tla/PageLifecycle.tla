-------------------------- MODULE PageLifecycle --------------------------
EXTENDS Naturals

(* PageHide/Return: watchPageVisibility; Inactive/Activate/Repair: lib.rs and
   shielded_native_did_become_active via UIApplication.didBecomeActive.
   Poll/Begin/Dispatch/Complete: createNativeTorMonitor. Lock abstracts an
   explicit owner revocation. Transport, keys and payments are not modeled. *)
CONSTANTS MaxEvents, BreakNativeGate, BreakDispatchFence, BreakDeliveryFence, BreakPollGate
VARIABLE s
vars == <<s>>

Init == s = [page |-> TRUE, native |-> TRUE, observed |-> TRUE,
    ready |-> TRUE, revision |-> 0, ticket |-> 0, events |-> 0,
    probe |-> "idle", cancelled |-> FALSE, badDispatch |-> FALSE, badDelivery |-> FALSE]

PageHide == /\ s.page /\ s.events < MaxEvents
    /\ s' = [s EXCEPT !.page = FALSE, !.revision = @ + 1,
        !.cancelled = TRUE, !.events = @ + 1]
PageReturn == /\ ~s.page /\ s.events < MaxEvents
    /\ s' = [s EXCEPT !.page = TRUE, !.events = @ + 1]
Inactive == /\ s.native /\ s.events < MaxEvents
    /\ s' = [s EXCEPT !.native = FALSE, !.observed = FALSE,
        !.revision = @ + 1, !.cancelled = TRUE, !.events = @ + 1]
Activate == /\ ~s.native /\ s.events < MaxEvents
    /\ s' = [s EXCEPT !.native = TRUE, !.events = @ + 1]
Repair == /\ s.native /\ ~s.observed
    /\ s' = [s EXCEPT !.observed = TRUE]
Poll == /\ s.page /\ (~BreakPollGate \/ s.observed)
    /\ s' = [s EXCEPT !.observed = s.native]
Lock == /\ s.ready
    /\ s' = [s EXCEPT !.ready = FALSE, !.revision = @ + 1, !.cancelled = TRUE]
Begin == /\ s.page /\ s.ready /\ (s.observed \/ BreakNativeGate)
    /\ s.probe = "idle"
    /\ s' = [s EXCEPT !.probe = "queued", !.ticket = s.revision, !.cancelled = FALSE]
Dispatch == /\ s.probe = "queued"
    /\ ((~s.cancelled /\ s.page /\ s.ready /\ s.observed /\ s.ticket = s.revision) \/ BreakDispatchFence)
    /\ s' = [s EXCEPT !.probe = "running",
        !.badDispatch = @ \/ ~s.page \/ ~s.ready \/ ~s.observed \/ s.ticket # s.revision]
Complete == /\ s.probe = "running"
    /\ ((~s.cancelled /\ s.page /\ s.ready /\ s.observed /\ s.ticket = s.revision) \/ BreakDeliveryFence)
    /\ s' = [s EXCEPT !.probe = "idle",
        !.badDelivery = @ \/ ~s.page \/ ~s.ready \/ ~s.observed \/ s.ticket # s.revision]

Drop == /\ s.probe # "idle" /\ s.cancelled
    /\ s' = [s EXCEPT !.probe = "idle"]
Next == PageHide \/ PageReturn \/ Inactive \/ Activate \/ Repair \/ Poll \/ Lock \/ Begin \/ Dispatch \/ Complete \/ Drop
TypeOK == /\ s.page \in BOOLEAN /\ s.native \in BOOLEAN /\ s.observed \in BOOLEAN
    /\ s.ready \in BOOLEAN /\ s.probe \in {"idle", "queued", "running"}
    /\ s.events \in 0..MaxEvents /\ s.revision \in 0..(MaxEvents + 1)
NoHiddenProbe == s.probe # "queued" \/ s.cancelled \/ s.observed
NoRetiredDispatch == ~s.badDispatch
NoRetiredDelivery == ~s.badDelivery
MissedActivationRecoverable == (s.page /\ s.native /\ ~s.observed) => ENABLED Poll
Spec == Init /\ [][Next]_vars
=============================================================================
