---- MODULE TorStartup ----
EXTENDS Naturals, FiniteSets

\* SetupReserve/RequestStart: lib.rs run -> PrivacyTransport::prewarm -> Inner::prepare_start.
\* WorkerBegin/DrainAck: StartupWork::run_with_bootstrap, Inner::check_start, Session::start_matches.
\* Commit/OwnerAbort/Complete: Inner::finish_start, StartupWork::drop, Startup::finish.
\* Read/Bind/Observe/Pause: Startup::waiter, StartWaiter::wait, Session::invalidate.
CONSTANTS Callers, MaxJobs, MaxGeneration, BreakReservation, BreakSingleFlight,
          BreakStartFence, BreakCompletionFence, BreakReplyFence,
          BreakReadiness, BreakDrain, BreakNotification, BreakCallerOwnership, BreakTerminalCas
VARIABLES phase, mode, generation, intentEpoch, issued, currentJob,
          hostQueued, visible, oldResources, jobStage, jobGeneration,
          jobMode, jobEpoch, result, terminal, firstResult, done, callerStage, callerJob,
          callerGeneration, callerMode, reply, bad

vars == <<phase, mode, generation, intentEpoch, issued, currentJob,
          hostQueued, visible, oldResources, jobStage, jobGeneration,
          jobMode, jobEpoch, result, terminal, firstResult, done, callerStage, callerJob,
          callerGeneration, callerMode, reply, bad>>
Jobs == 1..MaxJobs
Modes == {"tor", "direct"}
Phases == {"locked", "bootstrapping", "ready", "paused", "error"}
Stages == {"unused", "unreserved", "queued", "running", "captured", "done"}
Results == {"none", "ready", "error", "aborted"}
Failures == {"retired-start", "stale-completion", "stale-reply", "premature",
             "drain", "notification", "caller-ownership"}
Current(j) == jobGeneration[j] = generation /\ jobMode[j] = mode
              /\ phase = "bootstrapping"
OldJobsDone == \A j \in 1..issued : j = currentJob \/ jobStage[j] = "done"
Complete(j, outcome) ==
    /\ done' = [done EXCEPT ![j] = (@ \/ ~BreakNotification)]
    /\ terminal' = [terminal EXCEPT ![j] = IF done[j] /\ ~BreakTerminalCas THEN @ ELSE outcome]
    /\ firstResult' = [firstResult EXCEPT ![j] = IF done[j] THEN @ ELSE outcome]

Init ==
    /\ phase = "locked" /\ mode = "tor" /\ generation = 0 /\ intentEpoch = 0
    /\ issued = 0 /\ currentJob = 0 /\ hostQueued = FALSE /\ visible = FALSE
    /\ oldResources = FALSE
    /\ jobStage = [j \in Jobs |-> "unused"]
    /\ jobGeneration = [j \in Jobs |-> 0] /\ jobMode = [j \in Jobs |-> "tor"]
    /\ jobEpoch = [j \in Jobs |-> 0] /\ result = [j \in Jobs |-> "none"]
    /\ terminal = [j \in Jobs |-> "none"] /\ firstResult = [j \in Jobs |-> "none"]
    /\ done = [j \in Jobs |-> FALSE]
    /\ callerStage = [c \in Callers |-> "idle"]
    /\ callerJob = [c \in Callers |-> 0]
    /\ callerGeneration = [c \in Callers |-> 0]
    /\ callerMode = [c \in Callers |-> "tor"]
    /\ reply = [c \in Callers |-> "none"] /\ bad = {}

SetupReserve ==
    /\ ~hostQueued /\ issued = 0
    /\ hostQueued' = TRUE /\ issued' = 1 /\ currentJob' = 1
    /\ generation' = IF BreakReservation THEN 0 ELSE 1
    /\ phase' = IF BreakReservation THEN "locked" ELSE "bootstrapping"
    /\ jobStage' = [jobStage EXCEPT ![1] = IF BreakReservation THEN "unreserved" ELSE "queued"]
    /\ jobGeneration' = [jobGeneration EXCEPT ![1] = IF BreakReservation THEN 0 ELSE 1]
    /\ UNCHANGED <<mode, intentEpoch, visible, oldResources, jobMode,
                   jobEpoch, result, terminal, firstResult, done, callerStage, callerJob,
                   callerGeneration, callerMode, reply, bad>>

ShowWebview ==
    /\ hostQueued /\ ~visible /\ visible' = TRUE
    /\ UNCHANGED <<phase, mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, oldResources, jobStage, jobGeneration,
                   jobMode, jobEpoch, result, terminal, firstResult, done, callerStage, callerJob,
                   callerGeneration, callerMode, reply, bad>>

ReserveLate(j) ==
    /\ jobStage[j] = "unreserved" /\ generation < MaxGeneration
    /\ generation' = generation + 1 /\ phase' = "bootstrapping" /\ mode' = "tor"
    /\ currentJob' = j /\ jobStage' = [jobStage EXCEPT ![j] = "queued"]
    /\ jobGeneration' = [jobGeneration EXCEPT ![j] = generation + 1]
    /\ oldResources' = (oldResources \/ mode # "tor"
                        \/ (\E o \in 1..issued : o # j /\ jobStage[o] \notin {"unreserved", "done"}))
    /\ done' = [o \in Jobs |-> IF o = j THEN FALSE ELSE IF o = currentJob THEN (done[o] \/ ~BreakNotification) ELSE done[o]]
    /\ terminal' = [o \in Jobs |-> IF o = j THEN "none" ELSE IF o = currentJob /\ ~done[o] THEN "aborted" ELSE terminal[o]]
    /\ firstResult' = [o \in Jobs |-> IF o = j THEN "none" ELSE IF o = currentJob /\ ~done[o] THEN "aborted" ELSE firstResult[o]]
    /\ UNCHANGED <<intentEpoch, issued, hostQueued, visible,
                   jobMode, jobEpoch, result, callerStage, callerJob,
                   callerGeneration, callerMode, reply, bad>>

RequestStart(m) ==
    /\ visible /\ issued > 0 /\ issued < MaxJobs /\ generation < MaxGeneration
    /\ (phase \in {"paused", "error"} \/ mode # m)
    /\ LET j == issued + 1 IN
       /\ issued' = j /\ currentJob' = j /\ generation' = generation + 1
       /\ intentEpoch' = intentEpoch + 1
       /\ phase' = "bootstrapping" /\ mode' = m
       /\ oldResources' = (oldResources \/ mode # m
                           \/ (\E o \in 1..issued : jobStage[o] # "done"))
       /\ jobStage' = [jobStage EXCEPT ![j] = "queued"]
       /\ jobGeneration' = [jobGeneration EXCEPT ![j] = generation + 1]
       /\ jobMode' = [jobMode EXCEPT ![j] = m]
       /\ jobEpoch' = [jobEpoch EXCEPT ![j] = intentEpoch + 1]
    /\ Complete(currentJob, "aborted")
    /\ UNCHANGED <<hostQueued, visible, result, callerStage,
                   callerJob, callerGeneration, callerMode, reply, bad>>

DuplicateStart ==
    /\ BreakSingleFlight /\ phase = "bootstrapping" /\ issued < MaxJobs
    /\ LET j == issued + 1 IN
       /\ issued' = j /\ currentJob' = j
       /\ jobStage' = [jobStage EXCEPT ![j] = "queued"]
       /\ jobGeneration' = [jobGeneration EXCEPT ![j] = generation]
       /\ jobMode' = [jobMode EXCEPT ![j] = mode]
       /\ jobEpoch' = [jobEpoch EXCEPT ![j] = intentEpoch]
    /\ UNCHANGED <<phase, mode, generation, intentEpoch, hostQueued, visible,
                   oldResources, result, terminal, firstResult, done, callerStage, callerJob,
                   callerGeneration, callerMode, reply, bad>>

Pause ==
    /\ hostQueued /\ phase # "paused" /\ generation < MaxGeneration
    /\ generation' = generation + 1 /\ intentEpoch' = intentEpoch + 1
    /\ phase' = "paused" /\ oldResources' = TRUE
    /\ Complete(currentJob, "aborted")
    /\ UNCHANGED <<mode, issued, currentJob, hostQueued, visible, jobStage,
                   jobGeneration, jobMode, jobEpoch, result,
                   callerStage, callerJob, callerGeneration, callerMode, reply, bad>>

DrainAck ==
    /\ oldResources /\ OldJobsDone /\ oldResources' = FALSE
    /\ UNCHANGED <<phase, mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, visible, jobStage, jobGeneration, jobMode,
                   jobEpoch, result, terminal, firstResult, done, callerStage, callerJob,
                   callerGeneration, callerMode, reply, bad>>

WorkerBegin(j) ==
    /\ jobStage[j] = "queued" /\ (Current(j) \/ BreakStartFence)
    /\ (~oldResources \/ BreakDrain)
    /\ jobStage' = [jobStage EXCEPT ![j] = "running"]
    /\ bad' = bad \cup (IF ~Current(j) \/ jobEpoch[j] # intentEpoch THEN {"retired-start"} ELSE {})
                   \cup (IF oldResources THEN {"drain"} ELSE {})
    /\ UNCHANGED <<phase, mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, visible, oldResources, jobGeneration,
                   jobMode, jobEpoch, result, terminal, firstResult, done, callerStage, callerJob,
                   callerGeneration, callerMode, reply>>

Capture(j, outcome) ==
    /\ jobStage[j] = "running" /\ outcome \in {"ready", "error"}
    /\ jobStage' = [jobStage EXCEPT ![j] = "captured"]
    /\ result' = [result EXCEPT ![j] = outcome]
    /\ UNCHANGED <<phase, mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, visible, oldResources, jobGeneration,
                   jobMode, jobEpoch, terminal, firstResult, done, callerStage, callerJob,
                   callerGeneration, callerMode, reply, bad>>

AbortQueued(j) ==
    /\ jobStage[j] = "queued" /\ ~Current(j)
    /\ jobStage' = [jobStage EXCEPT ![j] = "captured"]
    /\ result' = [result EXCEPT ![j] = "aborted"]
    /\ UNCHANGED <<phase, mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, visible, oldResources, jobGeneration,
                   jobMode, jobEpoch, terminal, firstResult, done, callerStage, callerJob,
                   callerGeneration, callerMode, reply, bad>>

Commit(j) ==
    /\ jobStage[j] = "captured"
    /\ jobStage' = [jobStage EXCEPT ![j] = "done"]
    /\ Complete(j, result[j])
    /\ phase' = IF Current(j) \/ BreakCompletionFence
                 THEN IF result[j] = "ready" THEN "ready" ELSE "error" ELSE phase
    /\ bad' = bad \cup (IF BreakCompletionFence /\ ~Current(j) THEN {"stale-completion"} ELSE {})
                   \cup (IF BreakNotification THEN {"notification"} ELSE {})
    /\ UNCHANGED <<mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, visible, oldResources, jobGeneration,
                   jobMode, jobEpoch, result, callerStage, callerJob,
                   callerGeneration, callerMode, reply>>

OwnerAbort(j) ==
    /\ jobStage[j] \in {"queued", "running", "captured"}
    /\ jobStage' = [jobStage EXCEPT ![j] = "done"]
    /\ result' = [result EXCEPT ![j] = "aborted"]
    /\ Complete(j, "aborted")
    /\ phase' = IF Current(j) THEN "error" ELSE phase
    /\ bad' = bad \cup (IF BreakNotification THEN {"notification"} ELSE {})
    /\ UNCHANGED <<mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, visible, oldResources, jobGeneration,
                   jobMode, jobEpoch, callerStage, callerJob,
                   callerGeneration, callerMode, reply>>

Read(c) ==
    /\ visible /\ callerStage[c] = "idle" /\ phase \in {"ready", "bootstrapping"}
    /\ callerStage' = [callerStage EXCEPT ![c] = "captured"]
    /\ callerJob' = [callerJob EXCEPT ![c] = currentJob]
    /\ callerGeneration' = [callerGeneration EXCEPT ![c] = generation]
    /\ callerMode' = [callerMode EXCEPT ![c] = mode]
    /\ UNCHANGED <<phase, mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, visible, oldResources, jobStage, jobGeneration,
                   jobMode, jobEpoch, result, terminal, firstResult, done, reply, bad>>

Bind(c) ==
    /\ callerStage[c] = "captured"
    /\ callerStage' = [callerStage EXCEPT ![c] = IF BreakReadiness /\ ~done[callerJob[c]] THEN "returned" ELSE "waiting"]
    /\ reply' = [reply EXCEPT ![c] = IF BreakReadiness /\ ~done[callerJob[c]] THEN "bootstrapping" ELSE @]
    /\ bad' = bad \cup (IF BreakReadiness /\ ~done[callerJob[c]] THEN {"premature"} ELSE {})
    /\ UNCHANGED <<phase, mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, visible, oldResources, jobStage, jobGeneration,
                   jobMode, jobEpoch, result, terminal, firstResult, done, callerJob,
                   callerGeneration, callerMode>>

Observe(c) ==
    LET j == callerJob[c]
        valid == callerGeneration[c] = generation /\ callerMode[c] = mode /\ phase = "ready"
        ready == terminal[j] = "ready" /\ (valid \/ BreakReplyFence)
    IN
    /\ callerStage[c] = "waiting" /\ done[j]
    /\ callerStage' = [callerStage EXCEPT ![c] = "returned"]
    /\ reply' = [reply EXCEPT ![c] = IF ready THEN "ready" ELSE "error"]
    /\ bad' = bad \cup (IF ready /\ ~valid THEN {"stale-reply"} ELSE {})
    /\ UNCHANGED <<phase, mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, visible, oldResources, jobStage, jobGeneration,
                   jobMode, jobEpoch, result, terminal, firstResult, done, callerJob,
                   callerGeneration, callerMode>>

CancelCaller(c) ==
    LET j == callerJob[c]
        abort == BreakCallerOwnership /\ jobStage[j] \in {"queued", "running", "captured"}
    IN
    /\ callerStage[c] \in {"captured", "waiting"}
    /\ callerStage' = [callerStage EXCEPT ![c] = "cancelled"]
    /\ IF abort
       THEN /\ jobStage' = [jobStage EXCEPT ![j] = "done"]
            /\ result' = [result EXCEPT ![j] = "aborted"]
            /\ Complete(j, "aborted")
            /\ phase' = IF Current(j) THEN "error" ELSE phase
       ELSE UNCHANGED <<jobStage, result, terminal, firstResult, done, phase>>
    /\ bad' = bad \cup (IF abort THEN {"caller-ownership"} ELSE {})
    /\ UNCHANGED <<mode, generation, intentEpoch, issued, currentJob,
                   hostQueued, visible, oldResources, jobGeneration,
                   jobMode, jobEpoch, callerJob,
                   callerGeneration, callerMode, reply>>

Terminal == UNCHANGED vars
Next == SetupReserve \/ ShowWebview \/ Pause \/ DrainAck \/ DuplicateStart \/ Terminal
        \/ (\E m \in Modes : RequestStart(m))
        \/ (\E j \in Jobs : ReserveLate(j) \/ WorkerBegin(j) \/ AbortQueued(j)
              \/ Commit(j) \/ OwnerAbort(j) \/ (\E o \in {"ready", "error"} : Capture(j, o)))
        \/ (\E c \in Callers : Read(c) \/ Bind(c) \/ Observe(c) \/ CancelCaller(c))
Spec == Init /\ [][Next]_vars /\ (\A c \in Callers : WF_vars(Observe(c)))

TypeOK ==
    /\ phase \in Phases /\ mode \in Modes /\ generation \in 0..MaxGeneration
    /\ intentEpoch \in 0..MaxGeneration /\ issued \in 0..MaxJobs
    /\ currentJob \in 0..issued /\ hostQueued \in BOOLEAN /\ visible \in BOOLEAN
    /\ oldResources \in BOOLEAN /\ jobStage \in [Jobs -> Stages]
    /\ jobGeneration \in [Jobs -> 0..MaxGeneration] /\ jobMode \in [Jobs -> Modes]
    /\ jobEpoch \in [Jobs -> 0..MaxGeneration] /\ result \in [Jobs -> Results]
    /\ terminal \in [Jobs -> Results] /\ firstResult \in [Jobs -> Results]
    /\ done \in [Jobs -> BOOLEAN]
    /\ callerStage \in [Callers -> {"idle", "captured", "waiting", "returned", "cancelled"}]
    /\ callerJob \in [Callers -> 0..MaxJobs]
    /\ callerGeneration \in [Callers -> 0..MaxGeneration]
    /\ callerMode \in [Callers -> Modes] /\ reply \in [Callers -> {"none", "bootstrapping", "ready", "error"}]
    /\ bad \subseteq Failures
OneBootstrapPerGeneration == \A g \in 1..MaxGeneration : Cardinality({j \in 1..issued : jobGeneration[j] = g}) <= 1
NoRetiredIntentStart == "retired-start" \notin bad
NoStaleCompletion == "stale-completion" \notin bad
NoStaleReadyReply == "stale-reply" \notin bad
TerminalBeforeReply == "premature" \notin bad
DrainBeforeBootstrap == "drain" \notin bad
CompletionAlwaysSignals == \A j \in 1..issued : (jobStage[j] = "done" \/ jobGeneration[j] # generation) => done[j]
TerminalResultRetained == \A j \in 1..issued : done[j] => terminal[j] = firstResult[j]
CallerDoesNotOwnBootstrap == "caller-ownership" \notin bad
TerminalJoinersRelease == \A c \in Callers : (callerStage[c] = "waiting" /\ done[callerJob[c]]) ~> (callerStage[c] \in {"returned", "cancelled"})
====
