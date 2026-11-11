---------------------------- MODULE NativeWarmView ----------------------------
EXTENDS Naturals, FiniteSets

(* Hide/HardStop revoke graph generations; BeginFresh/PublishWallet create new graphs.
   Expiry capture/application: client+ticket guarded Inner::expire_warm.
   FirstFetch carries the immutable owner captured before proof/signing awaits. *)

CONSTANTS MaxGeneration, MaxWarmTickets, MaxClients, Grace, MaxTime,
    BreakGraphBinding, BreakVisibility, BreakDrain, BreakReadiness,
    BreakSnapshotCapability, BreakPresentationClear, BreakWarmDeadline,
    BreakExpiryFence, BreakResumeStarts
VARIABLE s
vars == <<s>>
Clients == 1..MaxClients
WarmTickets == 1..MaxWarmTickets
BothVisible == s.nativeActive /\ s.jsVisible
VisibilityGate == BothVisible \/ BreakVisibility
HasPresentation == s.snapshot # "none" \/ s.intent
GraphReady == s.graph = s.gen /\ s.phase = "ready"
DropPresentation(next) == [next EXCEPT
    !.snapshot = IF BreakPresentationClear THEN @ ELSE "none",
    !.intent = IF BreakPresentationClear THEN @ ELSE FALSE,
    !.badClear = @ \/ (BreakPresentationClear /\ (next.snapshot # "none" \/ next.intent))]

Init == s = [phase |-> "ready", gen |-> 1, graph |-> 1, nativeActive |-> TRUE,
    jsVisible |-> TRUE, locked |-> FALSE, destroyed |-> FALSE, drained |-> TRUE,
    torReady |-> TRUE, bootstrap |-> "none", client |-> 1,
    dormancy |-> [c \in Clients |-> IF c = 1 THEN "normal" ELSE "soft"],
    now |-> 0, warmCount |-> 0, warmActive |-> FALSE, warmDeadline |-> 0,
    timers |-> [t \in WarmTickets |-> [client |-> 0, deadline |-> 0, fired |-> FALSE]],
    expiry |-> [stage |-> "none", ticket |-> 0], snapshot |-> "none",
    snapshotDeadline |-> 0, intent |-> FALSE,
    operation |-> [pc |-> "idle", born |-> 0, fetch |-> 0],
    badOld |-> FALSE, badHidden |-> FALSE, badDrain |-> FALSE, badReady |-> FALSE,
    badClear |-> FALSE, badExtension |-> FALSE, badExpiry |-> FALSE, badResume |-> FALSE]

WantScanner == /\ GraphReady /\ ~s.intent /\ s' = [s EXCEPT !.intent = TRUE]

Hide(sensor) ==
    /\ s.gen < MaxGeneration
    /\ LET warm == s.phase = "ready" /\ s.torReady /\ s.warmCount < MaxWarmTickets
           duplicate == s.phase = "paused" /\ s.warmActive /\ s.now < s.warmDeadline
           visible == IF sensor = "native" THEN [s EXCEPT !.nativeActive = FALSE]
                ELSE [s EXCEPT !.jsVisible = FALSE]
           revoked == [visible EXCEPT !.phase = "paused", !.gen = @ + 1,
                !.graph = 0, !.drained = FALSE, !.bootstrap = "none"]
           retained == IF GraphReady THEN [revoked EXCEPT
                !.snapshot = IF BreakSnapshotCapability THEN "graph" ELSE "frozen-strings",
                !.snapshotDeadline = s.now + Grace]
             ELSE IF HasPresentation /\ s.now >= s.snapshotDeadline THEN DropPresentation(revoked)
             ELSE revoked
       IN IF warm
          THEN s' = [retained EXCEPT !.warmCount = @ + 1, !.warmActive = TRUE,
              !.warmDeadline = s.now + Grace,
              !.timers[s.warmCount + 1] = [client |-> s.client, deadline |-> s.now + Grace, fired |-> FALSE]]
          ELSE IF duplicate
          THEN s' = [retained EXCEPT
              !.warmDeadline = IF BreakWarmDeadline THEN s.now + Grace ELSE @,
              !.badExtension = @ \/ (BreakWarmDeadline /\ s.now + Grace > s.warmDeadline)]
          ELSE s' = [retained EXCEPT !.warmActive = FALSE, !.torReady = FALSE,
              !.dormancy[s.client] = "soft"]

NativeResume ==
    /\ ~s.nativeActive /\ ~s.destroyed /\ s.gen < MaxGeneration
    /\ IF BreakResumeStarts
       THEN s' = [s EXCEPT !.nativeActive = TRUE, !.phase = "starting", !.gen = @ + 1,
            !.graph = 0, !.bootstrap = "checking", !.torReady = FALSE,
            !.warmActive = FALSE, !.dormancy[s.client] = "normal", !.badResume = TRUE]
       ELSE s' = IF HasPresentation /\ s.now >= s.snapshotDeadline
            THEN DropPresentation([s EXCEPT !.nativeActive = TRUE])
            ELSE [s EXCEPT !.nativeActive = TRUE]

ShowJS ==
    /\ ~s.jsVisible /\ ~s.destroyed
    /\ s' = IF HasPresentation /\ s.now >= s.snapshotDeadline
        THEN DropPresentation([s EXCEPT !.jsVisible = TRUE]) ELSE [s EXCEPT !.jsVisible = TRUE]

DrainAck == /\ ~s.drained /\ s' = [s EXCEPT !.drained = TRUE]
Tick == /\ s.now < MaxTime /\ s' = [s EXCEPT !.now = @ + 1]

BeginFresh ==
    /\ s.phase = "paused" /\ VisibilityGate /\ ~s.locked /\ ~s.destroyed /\ s.gen < MaxGeneration
    /\ LET next == [s EXCEPT !.phase = "starting", !.gen = @ + 1, !.graph = 0,
                !.bootstrap = "checking", !.torReady = FALSE, !.warmActive = FALSE,
                !.dormancy[s.client] = "normal"]
       IN s' = IF HasPresentation /\ s.now >= s.snapshotDeadline THEN DropPresentation(next) ELSE next

ReadyResult(ok) ==
    /\ s.phase = "starting" /\ s.bootstrap = "checking"
    /\ s' = [s EXCEPT !.bootstrap = IF ok THEN "ready" ELSE "failed"]

ConfirmReady ==
    /\ s.phase = "starting" /\ VisibilityGate /\ ~s.locked /\ ~s.destroyed
    /\ (s.drained \/ BreakDrain) /\ (s.bootstrap = "ready" \/ BreakReadiness)
    /\ s' = [s EXCEPT !.phase = "ready", !.torReady = TRUE,
        !.badDrain = @ \/ ~s.drained, !.badReady = @ \/ (s.bootstrap # "ready")]

PublishWallet ==
    /\ s.phase = "ready" /\ s.graph = 0 /\ VisibilityGate /\ ~s.locked /\ ~s.destroyed
    /\ s' = [s EXCEPT !.graph = s.gen, !.snapshot = "none"]

ConsumeScanner ==
    /\ GraphReady /\ s.intent /\ s.now < s.snapshotDeadline
    /\ s' = [s EXCEPT !.intent = FALSE]

HardStop(reason) ==
    /\ s.gen < MaxGeneration /\ ~s.destroyed
    /\ s' = DropPresentation([s EXCEPT !.phase = "paused", !.gen = @ + 1,
        !.graph = 0, !.drained = FALSE, !.torReady = FALSE, !.bootstrap = "none",
        !.warmActive = FALSE, !.dormancy[s.client] = "soft",
        !.locked = @ \/ reason = "lock", !.destroyed = reason = "destroy"])

Unlock == /\ s.locked /\ ~s.destroyed /\ s' = [s EXCEPT !.locked = FALSE]

ReplaceClient ==
    /\ s.phase = "paused" /\ ~s.warmActive /\ s.dormancy[s.client] = "soft" /\ s.client < MaxClients
    /\ s' = [s EXCEPT !.client = @ + 1, !.torReady = FALSE]

ReadExpiry(t) ==
    /\ s.expiry.stage = "none" /\ t \in 1..s.warmCount
    /\ ~s.timers[t].fired /\ s.now >= s.timers[t].deadline
    /\ s' = [s EXCEPT !.expiry = [stage |-> "captured", ticket |-> t]]

ApplyExpiry ==
    /\ s.expiry.stage = "captured"
    /\ LET t == s.expiry.ticket
           current == s.warmActive /\ t = s.warmCount /\ s.timers[t].client = s.client
                /\ s.phase = "paused" /\ ~BothVisible /\ s.now >= s.warmDeadline
           changesCurrent == (s.timers[t].client = s.client /\ s.dormancy[s.client] = "normal")
                \/ s.warmActive \/ HasPresentation
           next == [s EXCEPT !.expiry = [stage |-> "none", ticket |-> 0], !.timers[t].fired = TRUE]
       IN IF current \/ BreakExpiryFence
          THEN s' = DropPresentation([next EXCEPT !.dormancy[s.timers[t].client] = "soft",
              !.warmActive = FALSE, !.badExpiry = @ \/ (~current /\ changesCurrent)])
          ELSE s' = next

BeginOperation ==
    /\ s.operation.pc = "idle" /\ GraphReady /\ VisibilityGate /\ ~s.locked /\ ~s.destroyed
    /\ s' = [s EXCEPT !.operation = [pc |-> "proof", born |-> s.graph, fetch |-> 0]]

FirstFetch ==
    /\ s.operation.pc = "proof"
    /\ s' = [s EXCEPT !.operation.pc = "fetch",
        !.operation.fetch = IF BreakGraphBinding THEN s.gen ELSE s.operation.born]

Dispatch ==
    /\ s.operation.pc = "fetch" /\ s.phase = "ready" /\ VisibilityGate
    /\ s.operation.fetch = s.gen /\ ~s.locked /\ ~s.destroyed
    /\ s' = [s EXCEPT !.operation.pc = "sent", !.badHidden = @ \/ ~BothVisible,
        !.badOld = @ \/ (s.operation.born # s.gen)]

Response == /\ s.operation.pc = "sent" /\ s' = [s EXCEPT !.operation.pc = "response"]
Deliver ==
    /\ s.operation.pc = "response" /\ s.phase = "ready" /\ BothVisible
    /\ s.operation.fetch = s.gen /\ ~s.locked /\ ~s.destroyed
    /\ s' = [s EXCEPT !.operation.pc = "done", !.badOld = @ \/ (s.operation.born # s.gen)]

Next == WantScanner \/ (\E sensor \in {"native", "js"} : Hide(sensor))
    \/ NativeResume \/ ShowJS \/ DrainAck \/ Tick \/ BeginFresh
    \/ (\E ok \in BOOLEAN : ReadyResult(ok)) \/ ConfirmReady \/ PublishWallet \/ ConsumeScanner
    \/ (\E reason \in {"lock", "reset", "mode", "destroy"} : HardStop(reason))
    \/ Unlock \/ ReplaceClient \/ (\E t \in WarmTickets : ReadExpiry(t)) \/ ApplyExpiry
    \/ BeginOperation \/ FirstFetch \/ Dispatch \/ Response \/ Deliver

TypeOK == s \in [phase: {"ready", "paused", "starting"}, gen: 1..MaxGeneration,
    graph: 0..MaxGeneration, nativeActive: BOOLEAN, jsVisible: BOOLEAN, locked: BOOLEAN,
    destroyed: BOOLEAN, drained: BOOLEAN, torReady: BOOLEAN,
    bootstrap: {"none", "checking", "ready", "failed"}, client: Clients,
    dormancy: [Clients -> {"normal", "soft"}], now: 0..MaxTime,
    warmCount: 0..MaxWarmTickets, warmActive: BOOLEAN, warmDeadline: 0..(MaxTime + Grace),
    timers: [WarmTickets -> [client: 0..MaxClients, deadline: 0..(MaxTime + Grace), fired: BOOLEAN]],
    expiry: [stage: {"none", "captured"}, ticket: 0..MaxWarmTickets],
    snapshot: {"none", "frozen-strings", "graph"}, snapshotDeadline: 0..(MaxTime + Grace), intent: BOOLEAN,
    operation: [pc: {"idle", "proof", "fetch", "sent", "response", "done"},
        born: 0..MaxGeneration, fetch: 0..MaxGeneration],
    badOld: BOOLEAN, badHidden: BOOLEAN, badDrain: BOOLEAN, badReady: BOOLEAN,
    badClear: BOOLEAN, badExtension: BOOLEAN, badExpiry: BOOLEAN, badResume: BOOLEAN]
NoOldGraphDispatch == ~s.badOld
NoHiddenDispatch == ~s.badHidden
SnapshotNeverCapability == s.snapshot # "graph"
FullDrainBeforeReady == ~s.badDrain
FullReadinessBeforeReady == ~s.badReady
PresentationCleared == ~s.badClear
NoGraceExtension == ~s.badExtension
NoStaleDormancy == ~s.badExpiry
NativeResumeOnlySignals == ~s.badResume
Spec == Init /\ [][Next]_vars
=============================================================================
