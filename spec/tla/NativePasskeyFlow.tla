----------------------- MODULE NativePasskeyFlow -----------------------
EXTENDS Naturals
\* Begin/Cancel/Retire: app/src/NativeWallet.tsx setup operation owner.
\* PromptReply/Publish: app/src/native-passkeys.ts, RollupWallet.tsx showPhrase.
\* ReadVault/Prepare/Dispatch: native-passkey-operation.ts commitNativeSetup.
\* NativeWrite/Reply/Reconcile: shielded-platform secret_create, native-setup-journal.ts.
CONSTANTS Flows, RecoverableFlows, OtherSeed, MaxOwner, BreakOwner, BreakForeground,
    BreakIntent, BreakCreateOnly, BreakPublish, BreakRandomJournal
VARIABLE s
\* Pure safety: fairness and eventual provider completion are outside this model.
vars == <<s>>

Init == s = [owner |-> 1, page |-> TRUE, native |-> TRUE, ready |-> TRUE,
    active |-> 0, vault |-> 0, journal |-> 0, metadata |-> 0,
    flow |-> [f \in Flows |-> [step |-> "idle", owner |-> 0, seed |-> 0, seen |-> 0]],
    badOwner |-> FALSE, badForeground |-> FALSE, badOverwrite |-> FALSE, badPublish |-> FALSE]
Current(f) == s.active = f /\ s.flow[f].owner = s.owner /\ s.ready
Foreground == s.page /\ s.native
Begin(f) == /\ s.flow[f].step = "idle" /\ s.active = 0 /\ s.vault = 0
    /\ s.ready /\ Foreground
    /\ (s.journal = 0 \/ f \in RecoverableFlows)
    /\ s' = [s EXCEPT !.active = f,
        !.flow[f] = [step |-> "prompt", owner |-> s.owner,
            seed |-> IF s.journal = 0 THEN f ELSE s.journal, seen |-> 0]]
PromptReply(f) == /\ s.flow[f].step = "prompt"
    /\ s' = [s EXCEPT !.flow[f].step = "seed"]
ReadVault(f) == /\ s.flow[f].step = "seed"
    /\ s' = [s EXCEPT !.flow[f].step = "read", !.flow[f].seen = s.vault]
Prepare(f) == /\ s.flow[f].step = "read" /\ s.flow[f].seen = 0
    /\ (Current(f) \/ BreakOwner) /\ (Foreground \/ BreakForeground)
    /\ s.journal \in {0, s.flow[f].seed}
    /\ s' = [s EXCEPT !.flow[f].step = "intent",
        !.journal = IF BreakIntent \/ (f \notin RecoverableFlows /\ ~BreakRandomJournal) THEN 0 ELSE s.flow[f].seed]
Dispatch(f) == /\ s.flow[f].step = "intent"
    /\ (Current(f) \/ BreakOwner) /\ (Foreground \/ BreakForeground)
    /\ (s.journal = s.flow[f].seed \/ BreakIntent \/ f \notin RecoverableFlows)
    /\ s' = [s EXCEPT !.flow[f].step = "sent",
        !.badOwner = @ \/ ~Current(f), !.badForeground = @ \/ ~Foreground]
NativeWrite(f) == /\ s.flow[f].step = "sent"
    /\ LET seed == s.flow[f].seed
       IN s' = IF s.vault \in {0, seed} \/ BreakCreateOnly
           THEN [s EXCEPT !.vault = seed, !.flow[f].step = "written",
               !.badOverwrite = @ \/ (s.vault # 0 /\ s.vault # seed)]
           ELSE [s EXCEPT !.flow[f].step = "failed"]
Reply(f) == /\ s.flow[f].step = "written" /\ s.vault = s.flow[f].seed
    /\ s' = [s EXCEPT !.flow[f].step = "done", !.metadata = s.vault,
        !.journal = IF @ = s.vault THEN 0 ELSE @]
WriteFailure(f) == /\ s.flow[f].step = "sent"
    /\ s' = [s EXCEPT !.flow[f].step = "failed"]
Retry(f) == /\ s.flow[f].step = "failed" /\ f \notin RecoverableFlows
    /\ s.vault = 0 /\ s.journal = 0
    /\ s' = [s EXCEPT !.flow[f].step = "idle", !.active = IF @ = f THEN 0 ELSE @]
Publish(f) == /\ s.flow[f].step = "done"
    /\ ((Current(f) /\ Foreground) \/ BreakPublish)
    /\ s' = [s EXCEPT !.flow[f].step = "published", !.active = IF @ = f THEN 0 ELSE @,
        !.badPublish = @ \/ ~Current(f) \/ ~Foreground]
Cancel(f) == /\ s.flow[f].step \in {"prompt", "seed", "read", "intent", "failed"}
    /\ s' = [s EXCEPT !.flow[f].step = "cancelled", !.active = IF @ = f THEN 0 ELSE @]
Retire == /\ s.owner < MaxOwner
    /\ s' = [s EXCEPT !.owner = @ + 1, !.active = 0, !.ready = FALSE]
Reconnect == /\ ~s.ready /\ s' = [s EXCEPT !.ready = TRUE]
PageHide == /\ s.page /\ s' = [s EXCEPT !.page = FALSE]
PageShow == /\ ~s.page /\ s' = [s EXCEPT !.page = TRUE]
NativeHide == /\ s.native /\ s' = [s EXCEPT !.native = FALSE]
NativeShow == /\ ~s.native /\ s' = [s EXCEPT !.native = TRUE]
ExternalWrite == /\ s.vault = 0
    /\ s' = [s EXCEPT !.vault = OtherSeed, !.metadata = OtherSeed]
Reconcile == /\ s.vault # 0 /\ s.journal = s.vault
    /\ s' = [s EXCEPT !.metadata = s.vault, !.journal = 0]
Next == Retire \/ Reconnect \/ PageHide \/ PageShow \/ NativeHide \/ NativeShow
    \/ ExternalWrite \/ Reconcile \/ \E f \in Flows:
        Begin(f) \/ PromptReply(f) \/ ReadVault(f) \/ Prepare(f) \/ Dispatch(f)
        \/ NativeWrite(f) \/ WriteFailure(f) \/ Retry(f) \/ Reply(f) \/ Publish(f) \/ Cancel(f)
TypeOK == /\ s.owner \in 1..MaxOwner /\ s.active \in Flows \cup {0}
    /\ s.vault \in Flows \cup {0, OtherSeed} /\ s.journal \in Flows \cup {0}
    /\ s.metadata \in Flows \cup {0, OtherSeed}
    /\ \A f \in Flows: s.flow[f].step \in {"idle", "prompt", "seed", "read", "intent", "sent", "written", "done", "published", "cancelled", "failed"}
NoRetiredAdmission == ~s.badOwner
NoHiddenAdmission == ~s.badForeground
NoWalletOverwrite == ~s.badOverwrite
RecoverableWrite == s.vault \notin RecoverableFlows \/ s.metadata = s.vault \/ s.journal = s.vault
NoUnknownSetupIntent == s.journal = 0 \/ s.journal \in RecoverableFlows
NoRetiredPresentation == ~s.badPublish
Spec == Init /\ [][Next]_vars
=============================================================================
