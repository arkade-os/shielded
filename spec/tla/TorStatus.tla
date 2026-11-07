---- MODULE TorStatus ----
EXTENDS Naturals

CONSTANTS Polls, MaxRevision, BreakRevisionGuard, BreakPauseIntent

VARIABLES phase, nativePhase, revision, started, startPending,
          startRevision, startResult, progressed, pausePending, pauseIntent,
          pauseResult,
          pauseRequested, pauseCompleted, pollStage, pollRevision,
          pollPhase, contexts, readyCommitted

vars == <<phase, nativePhase, revision, started, startPending,
          startRevision, startResult, progressed, pausePending, pauseIntent,
          pauseResult,
          pauseRequested, pauseCompleted, pollStage, pollRevision,
          pollPhase, contexts, readyCommitted>>

Phases == {"bootstrapping", "ready", "paused"}
CanAccept(r) == (BreakRevisionGuard \/ r = revision)
                /\ ~pausePending /\ (BreakPauseIntent \/ ~pauseIntent)

Init == /\ phase = "paused" /\ nativePhase = "paused"
        /\ revision = 0 /\ started = FALSE /\ startPending = FALSE
        /\ startRevision = 0 /\ startResult = "none" /\ progressed = FALSE
        /\ pausePending = FALSE /\ pauseIntent = FALSE
        /\ pauseResult = "none" /\ pauseRequested = FALSE
        /\ pauseCompleted = FALSE /\ contexts = FALSE
        /\ readyCommitted = FALSE
        /\ pollStage = [p \in Polls |-> "idle"]
        /\ pollRevision = [p \in Polls |-> 0]
        /\ pollPhase = [p \in Polls |-> "paused"]

StartBegin ==
    /\ ~started /\ revision < MaxRevision
    /\ started' = TRUE /\ startPending' = TRUE
    /\ pauseIntent' = FALSE
    /\ phase' = "bootstrapping" /\ nativePhase' = "bootstrapping"
    /\ revision' = revision + 1 /\ startRevision' = revision + 1
    /\ UNCHANGED <<startResult, progressed, pausePending, pauseRequested,
                   pauseResult, pauseCompleted, pollStage, pollRevision, pollPhase,
                   contexts, readyCommitted>>

NativeProgress ==
    /\ nativePhase = "bootstrapping" /\ ~progressed
    /\ progressed' = TRUE
    /\ UNCHANGED <<phase, nativePhase, revision, started, startPending,
                   startRevision, startResult, pausePending, pauseIntent,
                   pauseResult, pauseRequested,
                   pauseCompleted, pollStage, pollRevision, pollPhase,
                   contexts, readyCommitted>>

NativeReady ==
    /\ nativePhase = "bootstrapping"
    /\ nativePhase' = "ready" /\ startResult' = "ready"
    /\ UNCHANGED <<phase, revision, started, startPending, startRevision,
                   progressed, pausePending, pauseIntent, pauseResult,
                   pauseRequested, pauseCompleted,
                   pollStage, pollRevision, pollPhase, contexts, readyCommitted>>

StartReply ==
    /\ startPending /\ startResult # "none"
    /\ LET accept == startRevision = revision /\ ~pausePending
                     /\ startResult = "ready"
       IN /\ (~accept \/ revision < MaxRevision)
          /\ phase' = IF accept THEN "ready" ELSE phase
          /\ revision' = IF accept THEN revision + 1 ELSE revision
          /\ contexts' = IF accept THEN TRUE ELSE contexts
          /\ readyCommitted' = (readyCommitted \/ accept)
    /\ startPending' = FALSE
    /\ UNCHANGED <<nativePhase, started, startRevision, startResult, progressed,
                   pausePending, pauseIntent, pauseResult, pauseRequested,
                   pauseCompleted, pollStage,
                   pollRevision, pollPhase>>

PollBegin(p) ==
    /\ pollStage[p] = "idle"
    /\ pollStage' = [pollStage EXCEPT ![p] = "requested"]
    /\ pollRevision' = [pollRevision EXCEPT ![p] = revision]
    /\ UNCHANGED <<phase, nativePhase, revision, started, startPending,
                   startRevision, startResult, progressed, pausePending,
                   pauseIntent, pauseResult,
                   pauseRequested, pauseCompleted, pollPhase, contexts,
                   readyCommitted>>

PollSnapshot(p) ==
    /\ pollStage[p] = "requested"
    /\ pollStage' = [pollStage EXCEPT ![p] = "pending"]
    /\ pollPhase' = [pollPhase EXCEPT ![p] = nativePhase]
    /\ UNCHANGED <<phase, nativePhase, revision, started, startPending,
                   startRevision, startResult, progressed, pausePending,
                   pauseIntent, pauseResult,
                   pauseRequested, pauseCompleted, pollRevision, contexts,
                   readyCommitted>>

PollReply(p) ==
    /\ pollStage[p] = "pending"
    /\ pollStage' = [pollStage EXCEPT ![p] = "done"]
    /\ LET accept == CanAccept(pollRevision[p])
           firstReady == accept /\ pollPhase[p] = "ready" /\ phase # "ready"
       IN /\ (~firstReady \/ revision < MaxRevision)
          /\ phase' = IF accept THEN pollPhase[p] ELSE phase
          /\ contexts' = IF accept THEN pollPhase[p] = "ready" ELSE contexts
          /\ revision' = IF firstReady THEN revision + 1 ELSE revision
          /\ readyCommitted' = (readyCommitted \/ firstReady)
    /\ UNCHANGED <<nativePhase, started, startPending, startRevision,
                   startResult, progressed, pausePending, pauseRequested,
                   pauseIntent, pauseResult, pauseCompleted, pollRevision,
                   pollPhase>>

PauseBegin ==
    /\ started /\ ~pauseRequested /\ revision < MaxRevision
    /\ phase' = "paused" /\ contexts' = FALSE
    /\ pausePending' = TRUE /\ pauseRequested' = TRUE
    /\ pauseIntent' = TRUE
    /\ revision' = revision + 1
    /\ UNCHANGED <<nativePhase, started, startPending, startRevision,
                   startResult, progressed, pauseResult, pauseCompleted, pollStage,
                   pollRevision, pollPhase, readyCommitted>>

NativePause ==
    /\ pausePending /\ pauseResult = "none" /\ nativePhase # "paused"
    /\ nativePhase' = "paused"
    /\ pauseResult' = "paused"
    /\ startResult' = IF startResult = "none" THEN "paused" ELSE startResult
    /\ UNCHANGED <<phase, revision, started, startPending, startRevision,
                   progressed, pausePending, pauseIntent, pauseRequested,
                   pauseCompleted,
                   pollStage, pollRevision, pollPhase, contexts, readyCommitted>>

NativePauseFailure ==
    /\ pausePending /\ pauseResult = "none"
    /\ pauseResult' = "failed"
    /\ UNCHANGED <<phase, nativePhase, revision, started, startPending,
                   startRevision, startResult, progressed, pausePending,
                   pauseIntent, pauseRequested, pauseCompleted, pollStage,
                   pollRevision, pollPhase, contexts, readyCommitted>>

PauseReply ==
    /\ pausePending /\ pauseResult # "none" /\ revision < MaxRevision
    /\ phase' = "paused" /\ contexts' = FALSE
    /\ revision' = revision + 1
    /\ pausePending' = FALSE /\ pauseCompleted' = TRUE
    /\ UNCHANGED <<nativePhase, started, startPending, startRevision,
                   startResult, progressed, pauseIntent, pauseResult,
                   pauseRequested, pollStage,
                   pollRevision, pollPhase, readyCommitted>>

Terminal == UNCHANGED vars
Next == StartBegin \/ NativeProgress \/ NativeReady \/ StartReply
        \/ PauseBegin \/ NativePause \/ NativePauseFailure \/ PauseReply
        \/ (\E p \in Polls : PollBegin(p) \/ PollSnapshot(p) \/ PollReply(p))
        \/ Terminal
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ phase \in Phases /\ nativePhase \in Phases
    /\ revision \in 0..MaxRevision /\ startRevision \in 0..MaxRevision
    /\ startResult \in {"none", "ready", "paused"}
    /\ pauseResult \in {"none", "paused", "failed"}
    /\ pollStage \in [Polls -> {"idle", "requested", "pending", "done"}]
    /\ pollRevision \in [Polls -> 0..MaxRevision]
    /\ pollPhase \in [Polls -> Phases]
    /\ \A b \in {started, startPending, progressed, pausePending, pauseIntent,
                  pauseRequested, pauseCompleted, contexts, readyCommitted} :
                  b \in BOOLEAN
    /\ contexts = (phase = "ready")

ReadyNeverRegresses == readyCommitted /\ ~pauseRequested
                       => phase = "ready" /\ contexts
NoReadyWhilePausing == pausePending => phase # "ready" /\ ~contexts
NoReadyAfterPause == pauseCompleted => phase # "ready" /\ ~contexts
====
