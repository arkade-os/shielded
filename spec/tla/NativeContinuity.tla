-------------------------- MODULE NativeContinuity --------------------------
EXTENDS Naturals

(* SoftHide/Show: Inner::suspend(true)/resumed and NativeWallet visibility handling.
   HardStop/Drain/Start/Bootstrap/Ready: Session::invalidate and native startup.
   RetireGraph: NativeWallet.pause/suspend, paired with native_pause invalidation.
   Mount/BeginOperation/FirstFetch: NativeWallet.open, NativeBridge.sessionGuard.
   BeginUpdate/Receive/Verify/Publish/Cancel: update controller and DownloadOwner.
   Install: createAndroidUpdateController.install and Android foreground guard. *)

CONSTANTS MaxGeneration, MaxBytes, BreakSoftOwner, BreakSoftDownload,
    BreakGraphBinding, BreakUpdateFence, BreakUpdateTor, BreakStartVisibility,
    BreakInstallVisibility, BreakDrain, BreakReadiness, BreakResumeStarts,
    BreakRetireInvalidates

Modes == {"tor", "direct"}
NetworkStages == {"receiving", "checked"}
VARIABLE s
vars == <<s>>

Init == s = [gen |-> 1, mode |-> "tor", phase |-> "ready", visible |-> TRUE,
    graph |-> 1, drained |-> TRUE, bootstrapped |-> TRUE,
    op |-> [stage |-> "idle", owner |-> 0, mode |-> "tor", live |-> FALSE],
    update |-> [stage |-> "idle", owner |-> 0, mode |-> "tor",
        bytes |-> 0, cancelled |-> FALSE],
    bad |-> {}]

SoftHide ==
    /\ s.visible /\ s.phase = "ready"
    /\ LET graph == IF BreakSoftOwner THEN 0 ELSE s.graph
           update == IF BreakSoftDownload /\ s.update.stage \in NetworkStages
                     THEN [s.update EXCEPT !.cancelled = TRUE, !.bytes = 0]
                     ELSE s.update
       IN s' = [s EXCEPT !.visible = FALSE, !.graph = graph, !.update = update,
           !.bad = @ \cup (IF graph # s.graph THEN {"soft-owner"} ELSE {})
               \cup (IF update # s.update THEN {"soft-download"} ELSE {})]

HideStarting ==
    /\ s.visible /\ s.phase # "ready"
    /\ s.phase = "starting" => s.gen < MaxGeneration
    /\ s' = [s EXCEPT !.visible = FALSE, !.phase = "stopped",
        !.gen = IF s.phase = "starting" THEN @ + 1 ELSE @,
        !.drained = IF s.phase = "starting" THEN FALSE ELSE @,
        !.bootstrapped = FALSE]

Show ==
    /\ ~s.visible
    /\ LET phase == IF BreakResumeStarts THEN "ready" ELSE s.phase
       IN s' = [s EXCEPT !.visible = TRUE, !.phase = phase,
           !.bad = @ \cup (IF phase # s.phase THEN {"resume"} ELSE {})]

HardStop(mode) ==
    /\ s.gen < MaxGeneration /\ s.phase # "stopped"
    /\ s' = [s EXCEPT !.gen = @ + 1, !.mode = mode, !.phase = "stopped",
        !.graph = 0, !.drained = FALSE, !.bootstrapped = FALSE, !.op.live = FALSE,
        !.update.cancelled = @ \/ s.update.stage \in NetworkStages]

\* A renderer-side retirement keeps the generation only when it is broken.
RetireGraph ==
    /\ s.phase = "ready" /\ s.graph # 0
    /\ IF BreakRetireInvalidates
       THEN s' = [s EXCEPT !.graph = 0, !.op.live = FALSE]
       ELSE /\ s.gen < MaxGeneration
            /\ s' = [s EXCEPT !.gen = @ + 1, !.phase = "stopped", !.graph = 0,
                !.drained = FALSE, !.bootstrapped = FALSE, !.op.live = FALSE,
                !.update.cancelled = @ \/ s.update.stage \in NetworkStages]

Drain ==
    /\ ~s.drained
    /\ s' = [s EXCEPT !.drained = TRUE]

Start ==
    /\ s.phase = "stopped" /\ (s.visible \/ BreakStartVisibility)
    /\ s' = [s EXCEPT !.phase = "starting",
        !.bad = @ \cup (IF ~s.visible THEN {"hidden-start"} ELSE {})]

Bootstrap ==
    /\ s.phase = "starting" /\ ~s.bootstrapped
    /\ s' = [s EXCEPT !.bootstrapped = TRUE]

Ready ==
    /\ s.phase = "starting"
    /\ (s.visible \/ BreakStartVisibility)
    /\ (s.drained \/ BreakDrain) /\ (s.bootstrapped \/ BreakReadiness)
    /\ s' = [s EXCEPT !.phase = "ready",
        !.bad = @ \cup (IF ~s.drained THEN {"drain"} ELSE {})
            \cup (IF ~s.bootstrapped THEN {"readiness"} ELSE {})
            \cup (IF ~s.visible THEN {"hidden-start"} ELSE {})]

Mount ==
    /\ s.phase = "ready" /\ s.graph = 0 /\ s.visible
    /\ s' = [s EXCEPT !.graph = s.gen]

BeginOperation ==
    /\ s.phase = "ready" /\ s.graph = s.gen /\ s.visible /\ s.op.stage = "idle"
    /\ s' = [s EXCEPT !.op = [stage |-> "prepared", owner |-> s.graph, mode |-> s.mode,
        live |-> TRUE]]

FirstFetch ==
    /\ s.op.stage = "prepared" /\ s.phase = "ready"
    /\ ((s.op.owner = s.gen /\ s.op.mode = s.mode) \/ BreakGraphBinding)
    /\ s' = [s EXCEPT !.op.stage = "sent",
        !.bad = @ \cup (IF s.op.owner # s.gen \/ s.op.mode # s.mode \/ ~s.op.live
                       THEN {"dispatch"} ELSE {})]

BeginUpdate ==
    /\ s.phase = "ready" /\ s.visible /\ s.update.stage = "idle"
    /\ (s.mode = "tor" \/ BreakUpdateTor)
    /\ s' = [s EXCEPT !.update = [stage |-> "receiving", owner |-> s.gen,
        mode |-> s.mode, bytes |-> 0, cancelled |-> FALSE],
        !.bad = @ \cup (IF s.mode # "tor" THEN {"update-tor"} ELSE {})]

Receive ==
    /\ s.update.stage = "receiving" /\ s.update.bytes < MaxBytes
    /\ ~s.update.cancelled /\ s.update.owner = s.gen /\ s.phase = "ready"
    /\ s' = [s EXCEPT !.update.bytes = @ + 1]

Verify ==
    /\ s.update.stage = "receiving" /\ s.update.bytes = MaxBytes
    /\ s' = [s EXCEPT !.update.stage = "checked"]

Publish ==
    /\ s.update.stage = "checked"
    /\ ((s.update.owner = s.gen /\ s.phase = "ready" /\ s.mode = "tor"
        /\ ~s.update.cancelled) \/ BreakUpdateFence)
    /\ s' = [s EXCEPT !.update.stage = "ready",
        !.bad = @ \cup (IF s.update.owner # s.gen \/ s.phase # "ready"
            \/ s.mode # "tor" \/ s.update.cancelled THEN {"update-publish"} ELSE {})]

Cancel ==
    /\ s.update.stage \in NetworkStages /\ ~s.update.cancelled
    /\ s' = [s EXCEPT !.update.cancelled = TRUE]

Install ==
    /\ s.update.stage = "ready" /\ (s.visible \/ BreakInstallVisibility)
    /\ s' = [s EXCEPT !.update.stage = "installed",
        !.bad = @ \cup (IF ~s.visible THEN {"hidden-install"} ELSE {})]

Next == SoftHide \/ HideStarting \/ Show \/ (\E mode \in Modes: HardStop(mode)) \/ Drain
    \/ RetireGraph \/ Start \/ Bootstrap \/ Ready \/ Mount \/ BeginOperation \/ FirstFetch
    \/ BeginUpdate \/ Receive \/ Verify \/ Publish \/ Cancel \/ Install

TypeOK == s \in [gen: 1..MaxGeneration, mode: Modes,
    phase: {"ready", "stopped", "starting"}, visible: BOOLEAN,
    graph: 0..MaxGeneration, drained: BOOLEAN, bootstrapped: BOOLEAN,
    op: [stage: {"idle", "prepared", "sent"}, owner: 0..MaxGeneration, mode: Modes,
        live: BOOLEAN],
    update: [stage: {"idle", "receiving", "checked", "ready", "installed"},
        owner: 0..MaxGeneration, mode: Modes, bytes: 0..MaxBytes, cancelled: BOOLEAN],
    bad: SUBSET {"soft-owner", "soft-download", "resume", "hidden-start",
        "hidden-install", "drain", "readiness", "dispatch", "update-tor", "update-publish"}]
SoftOwnerRetained == "soft-owner" \notin s.bad
SoftDownloadRetained == "soft-download" \notin s.bad
NoRevokedGraphDispatch == "dispatch" \notin s.bad
NoRevokedUpdatePublication == "update-publish" \notin s.bad
UpdateUsesTor == "update-tor" \notin s.bad
StartupNeedsForeground == "hidden-start" \notin s.bad
InstallerNeedsForeground == "hidden-install" \notin s.bad
FullDrainBeforeReady == "drain" \notin s.bad
FullReadinessBeforeReady == "readiness" \notin s.bad
ResumeOnlyChangesVisibility == "resume" \notin s.bad
Spec == Init /\ [][Next]_vars
=============================================================================
