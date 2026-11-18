------------------------ MODULE ApplePasskeyPrompt ------------------------
EXTENDS Naturals
\* Submit/Begin: macos.rs run/begin; Passkeys.swift PasskeyCeremony.start.
\* Tick: deadline.rs await_deadline; PasskeyDeadline.swift arm.
\* Cancel: macos.rs RetireOnDrop; PasskeyDeadline.swift cancel.
\* Callback/Cleanup: macos.rs delegate/cancel_owned; Passkeys.swift finish.
CONSTANTS Flows, MaxAge, BreakDeadline, BreakQueued, BreakCleanup, BreakCallback, BreakResult
VARIABLE s
vars == <<s>>
Init == s = [active |-> 0, queued |-> [f \in Flows |-> FALSE],
    alive |-> [f \in Flows |-> FALSE], begun |-> [f \in Flows |-> FALSE],
    result |-> [f \in Flows |-> "idle"], age |-> [f \in Flows |-> 0], cleanup |-> {},
    badStart |-> FALSE, badCleanup |-> FALSE, badCallback |-> FALSE, badResult |-> FALSE]
Submit(f) == /\ s.result[f] = "idle"
    /\ s' = [s EXCEPT !.queued[f] = TRUE, !.alive[f] = TRUE, !.result[f] = "pending"]
Begin(f) == /\ s.queued[f] /\ s.active = 0
    /\ s' = IF s.alive[f] \/ BreakQueued
        THEN [s EXCEPT !.queued[f] = FALSE, !.active = f, !.begun[f] = TRUE,
            !.badStart = @ \/ ~s.alive[f]]
        ELSE [s EXCEPT !.queued[f] = FALSE]
RejectBusy(f) == /\ s.queued[f] /\ s.active # 0
    /\ s' = [s EXCEPT !.queued[f] = FALSE, !.alive[f] = FALSE, !.result[f] = "unavailable"]
Tick(f) == /\ s.result[f] = "pending" /\ s.age[f] < MaxAge
    /\ s' = IF s.age[f] + 1 = MaxAge /\ ~BreakDeadline
        THEN [s EXCEPT !.age[f] = @ + 1, !.alive[f] = FALSE,
            !.result[f] = "unavailable", !.cleanup = @ \cup {f}]
        ELSE [s EXCEPT !.age[f] = @ + 1]
Cancel(f) == /\ s.result[f] = "pending"
    /\ s' = [s EXCEPT !.alive[f] = FALSE, !.result[f] = "unavailable", !.cleanup = @ \cup {f}]
Callback(f) == /\ s.begun[f]
    /\ s' = [s EXCEPT
        !.active = IF s.active = f \/ BreakCallback THEN 0 ELSE @,
        !.alive[f] = FALSE,
        !.result[f] = IF @ = "pending" \/ BreakResult THEN "success" ELSE @,
        !.cleanup = @ \cup {f},
        !.badCallback = @ \/ (BreakCallback /\ s.active # 0 /\ s.active # f),
        !.badResult = @ \/ (BreakResult /\ s.result[f] = "unavailable")]
Cleanup(f) == /\ f \in s.cleanup
    /\ s' = [s EXCEPT !.cleanup = @ \ {f},
        !.active = IF s.active = f \/ BreakCleanup THEN 0 ELSE @,
        !.badCleanup = @ \/ (BreakCleanup /\ s.active # 0 /\ s.active # f)]
Next == \E f \in Flows: Submit(f) \/ Begin(f) \/ RejectBusy(f) \/ Tick(f) \/ Cancel(f) \/ Callback(f) \/ Cleanup(f)
TypeOK == /\ s.active \in Flows \cup {0} /\ s.cleanup \subseteq Flows
    /\ \A f \in Flows: s.queued[f] \in BOOLEAN /\ s.alive[f] \in BOOLEAN /\ s.begun[f] \in BOOLEAN
        /\ s.result[f] \in {"idle", "pending", "success", "unavailable"} /\ s.age[f] \in 0..MaxAge
DeadlineCompletesRPC == \A f \in Flows: s.age[f] < MaxAge \/ s.result[f] # "pending"
NoExpiredStart == ~s.badStart
NoForeignCleanup == ~s.badCleanup
NoForeignCallback == ~s.badCallback
FirstResultWins == ~s.badResult
Spec == Init /\ [][Next]_vars
=============================================================================
