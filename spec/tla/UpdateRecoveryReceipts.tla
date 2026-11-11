------------------------ MODULE UpdateRecoveryReceipts ------------------------
EXTENDS Naturals, FiniteSets

(* ReceiveTerminal/Recover: AndroidUpdater.receive/install, AndroidUpdatePolicy.terminalResult.
   ClassifyFailure/PublishFailure/BeginOperation: AndroidUpdateDispatch.
   Deliver: InstallOwner::finish consumes a definite failed install receipt. *)

CONSTANTS FailureCodes, BreakTerminalReceipt, BreakCancelledReceipt, BreakDispatchFence
VARIABLE s
vars == <<s>>
Callers == {1, 2}
Terminal == {"installed", "failed"}
Errors == FailureCodes \cup {"none", "old-error", "bridge-error", "precommit-error", "uncertain"}
Statuses == {"none", "installing", "confirmation-required"} \cup Terminal
Journal(status, error, token, session) ==
    [status |-> status, error |-> error, token |-> token, session |-> session,
        target |-> IF token = "old" THEN 1 ELSE 2]

Init ==
    \E kind \in {"install", "other"}, oldStatus \in Terminal :
    s = [kind |-> kind, gate |-> "queued", phase |-> "queued", session |-> 0,
        journal |-> Journal(oldStatus, IF oldStatus = "installed" THEN "none" ELSE "old-error", "old", 1),
        callback |-> Journal("none", "none", "current", 0), callbackSeen |-> FALSE,
        terminalBeforeRecovery |-> FALSE, recovered |-> FALSE, possibleCommit |-> FALSE,
        faults |-> [w \in Callers |-> "idle"], definite |-> FALSE,
        responseKind |-> "none", responseStatus |-> "none", responseError |-> "none",
        responseSource |-> "none", delivered |-> FALSE,
        root |-> IF kind = "install" THEN "holding" ELSE "none", lateDispatch |-> FALSE]

ClassifyFailure(w) ==
    /\ s.faults[w] = "idle"
    /\ LET wonCancellation == s.gate = "queued"
           nextGate == IF wonCancellation THEN "cancelled" ELSE s.gate
           known == s.kind = "install" /\ nextGate = "cancelled"
                /\ (~BreakCancelledReceipt \/ wonCancellation)
       IN s' = [s EXCEPT !.gate = nextGate,
          !.faults[w] = IF known THEN "known" ELSE "error"]

PublishFailure(w) ==
    /\ s.faults[w] \in {"known", "error"} /\ s.responseKind = "none"
    /\ s' = [s EXCEPT !.responseKind = IF s.faults[w] = "known" THEN "structured" ELSE "error",
        !.responseStatus = IF s.faults[w] = "known" THEN "failed" ELSE "none",
        !.responseError = "bridge-error", !.responseSource = "wrapper",
        !.definite = (s.gate = "cancelled"), !.faults[w] = "published"]

BeginOperation ==
    /\ s.phase = "queued"
    /\ s.gate = "queued" \/ (BreakDispatchFence /\ s.gate = "cancelled")
    /\ s' = [s EXCEPT !.gate = "started", !.phase = "entered",
        !.lateDispatch = s.gate = "cancelled"]

EnterInstall ==
    /\ s.kind = "install" /\ s.phase = "entered"
    /\ s' = [s EXCEPT !.phase = "validating"]

PrepareSession ==
    /\ s.phase = "validating"
    /\ s' = [s EXCEPT !.phase = "prepared", !.session = 2,
        !.journal = Journal("installing", "none", "current", 2)]

CommitPossible ==
    /\ s.phase = "prepared"
    /\ s' = [s EXCEPT !.phase = "committed", !.possibleCommit = TRUE]

StartRecovery ==
    /\ s.phase = "committed"
    /\ s' = [s EXCEPT !.phase = "recovering"]

ReceiveTerminal(status, error) ==
    /\ s.possibleCommit /\ s.phase \in {"committed", "recovering", "done"}
    /\ s.journal.token = "current" /\ s.journal.session = s.session /\ s.session = 2
    /\ s.journal.status \in {"installing", "confirmation-required"} /\ ~s.callbackSeen
    /\ s' = [s EXCEPT !.journal = Journal(status, error, "current", s.session),
        !.callback = Journal(status, error, "current", s.session), !.callbackSeen = TRUE]

Recover ==
    /\ s.phase \in {"validating", "prepared", "recovering"}
    /\ LET matchingTerminal == s.session > 0 /\ s.journal.token = "current" /\ s.journal.target = 2
                /\ s.journal.session = s.session /\ s.journal.status \in Terminal
           preserve == matchingTerminal /\ ~BreakTerminalReceipt
           outcome == IF preserve THEN s.journal ELSE Journal(
                IF s.possibleCommit THEN "confirmation-required" ELSE "failed",
                IF s.possibleCommit THEN "uncertain" ELSE "precommit-error", "current", s.session)
           reply == s.responseKind = "none"
       IN s' = [s EXCEPT !.journal = outcome, !.phase = "done", !.recovered = TRUE,
          !.terminalBeforeRecovery = matchingTerminal,
          !.responseKind = IF reply THEN "structured" ELSE @,
          !.responseStatus = IF reply THEN outcome.status ELSE @,
          !.responseError = IF reply THEN outcome.error ELSE @,
          !.responseSource = IF reply THEN "recovery" ELSE @]

CompleteOperation ==
    /\ s.gate = "started" /\ s.phase \in {"entered", "committed"}
    /\ s.kind = "other" \/ s.possibleCommit
    /\ LET reply == s.responseKind = "none"
       IN s' = [s EXCEPT !.phase = "done",
          !.responseKind = IF reply THEN "structured" ELSE @,
          !.responseStatus = IF reply THEN "installing" ELSE @,
          !.responseError = IF reply THEN "none" ELSE @,
          !.responseSource = IF reply THEN "operation" ELSE @]

Deliver ==
    /\ s.responseKind # "none" /\ ~s.delivered
    /\ s' = [s EXCEPT !.delivered = TRUE,
        !.root = IF s.kind # "install" THEN "none"
            ELSE IF s.responseKind = "structured" /\ s.responseStatus = "failed" THEN "ready"
            ELSE IF s.responseKind = "structured" /\ s.responseStatus = "installed" THEN "done"
            ELSE "holding"]

Next == (\E w \in Callers : ClassifyFailure(w) \/ PublishFailure(w))
    \/ BeginOperation \/ EnterInstall \/ PrepareSession \/ CommitPossible \/ StartRecovery
    \/ (\E error \in FailureCodes : ReceiveTerminal("failed", error))
    \/ ReceiveTerminal("installed", "none") \/ Recover \/ CompleteOperation \/ Deliver

TypeOK == s \in [kind: {"install", "other"}, gate: {"queued", "started", "cancelled"},
    phase: {"queued", "entered", "validating", "prepared", "committed", "recovering", "done"},
    session: {0, 2}, journal: [status: Statuses, error: Errors, token: {"old", "current"}, session: 0..2, target: 1..2],
    callback: [status: Statuses, error: Errors, token: {"old", "current"}, session: 0..2, target: 1..2],
    callbackSeen: BOOLEAN, terminalBeforeRecovery: BOOLEAN, recovered: BOOLEAN, possibleCommit: BOOLEAN,
    faults: [Callers -> {"idle", "known", "error", "published"}], definite: BOOLEAN,
    responseKind: {"none", "error", "structured"}, responseStatus: Statuses,
    responseError: Errors, responseSource: {"none", "wrapper", "recovery", "operation"},
    delivered: BOOLEAN, root: {"none", "holding", "ready", "done"}, lateDispatch: BOOLEAN]
NoCancelledDispatch == ~s.lateDispatch
TerminalReceiptRetained == s.callbackSeen => s.journal = s.callback
TerminalReplyRetained ==
    (s.terminalBeforeRecovery /\ s.responseSource = "recovery") =>
        s.responseStatus = s.callback.status /\ s.responseError = s.callback.error
OldReceiptNotAdopted ==
    (s.recovered /\ ~s.possibleCommit /\ s.responseSource = "recovery") =>
        s.responseStatus = "failed" /\ s.responseError = "precommit-error"
DefiniteInstallRejectionRetryable ==
    (s.kind = "install" /\ s.definite /\ s.delivered) => s.root = "ready"
StartedWrapperFailureAmbiguous ==
    (s.responseSource = "wrapper" /\ s.gate = "started") => s.responseKind = "error"
OtherWrapperErrorsStayErrors ==
    (s.responseSource = "wrapper" /\ s.kind = "other") => s.responseKind = "error"
Spec == Init /\ [][Next]_vars
=============================================================================
