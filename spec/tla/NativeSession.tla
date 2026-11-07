---- MODULE NativeSession ----
EXTENDS Naturals, FiniteSets

CONSTANTS Workers, MaxGeneration, MaxObservations,
          BreakDispatchFence, BreakDeliveryFence, BreakClaimCAS,
          BreakPersistBeforeSend, BreakUnknownReplay, BreakUnknownRelease

VARIABLES phase, generation, pc, kind, requestGeneration, observedPrepared,
          evidence, journal, reserved, sends, inFlight, effects,
          observations, timeouts, badDispatch, badDelivery, badJournal, requeued

vars == <<phase, generation, pc, kind, requestGeneration, observedPrepared,
          evidence, journal, reserved, sends, inFlight, effects,
          observations, timeouts, badDispatch, badDelivery, badJournal, requeued>>

Phases == {"locked", "bootstrapping", "ready", "paused"}
Kinds == {"none", "read", "stream", "mutation", "status"}
Stages == {"idle", "captured", "claimed", "waiting", "response"}
GoodSession(w) == phase = "ready" /\ requestGeneration[w] = generation

Init == /\ phase = "locked"
        /\ generation = 0
        /\ pc = [w \in Workers |-> "idle"]
        /\ kind = [w \in Workers |-> "none"]
        /\ requestGeneration = [w \in Workers |-> 0]
        /\ observedPrepared = [w \in Workers |-> FALSE]
        /\ evidence = [w \in Workers |-> FALSE]
        /\ journal = "empty"
        /\ reserved = FALSE
        /\ sends = 0 /\ inFlight = 0 /\ effects = 0
        /\ observations = 0 /\ timeouts = 0
        /\ badDispatch = FALSE /\ badDelivery = FALSE
        /\ badJournal = FALSE /\ requeued = FALSE

Unlock == /\ phase = "locked" /\ generation < MaxGeneration
          /\ phase' = "bootstrapping" /\ generation' = generation + 1
          /\ UNCHANGED <<pc, kind, requestGeneration, observedPrepared, evidence,
                         journal, reserved, sends, inFlight, effects,
                         observations, timeouts, badDispatch, badDelivery,
                         badJournal, requeued>>

Bootstrap == /\ phase = "bootstrapping"
             /\ phase' = "ready"
             /\ UNCHANGED <<generation, pc, kind, requestGeneration,
                            observedPrepared, evidence, journal, reserved,
                            sends, inFlight, effects, observations, timeouts,
                            badDispatch, badDelivery, badJournal, requeued>>

Invalidate(target) ==
    /\ phase \in {"bootstrapping", "ready", "paused"}
    /\ generation < MaxGeneration
    /\ phase' = target /\ generation' = generation + 1
    /\ UNCHANGED <<pc, kind, requestGeneration, observedPrepared, evidence,
                   journal, reserved, sends, inFlight, effects, observations,
                   timeouts, badDispatch, badDelivery, badJournal, requeued>>

Pause == /\ phase = "ready" /\ Invalidate("paused")
Lock == /\ phase # "locked" /\ Invalidate("locked")
Crash == /\ phase # "locked" /\ generation < MaxGeneration
         /\ phase' = "locked" /\ generation' = generation + 1
         /\ pc' = [w \in Workers |-> "idle"]
         /\ kind' = [w \in Workers |-> "none"]
         /\ requestGeneration' = [w \in Workers |-> 0]
         /\ observedPrepared' = [w \in Workers |-> FALSE]
         /\ evidence' = [w \in Workers |-> FALSE]
         /\ UNCHANGED <<journal, reserved, sends, inFlight, effects,
                        observations, timeouts, badDispatch, badDelivery,
                        badJournal, requeued>>

Resume == /\ phase = "paused"
          /\ phase' = "bootstrapping"
          /\ UNCHANGED <<generation, pc, kind, requestGeneration,
                         observedPrepared, evidence, journal, reserved,
                         sends, inFlight, effects, observations, timeouts,
                         badDispatch, badDelivery, badJournal, requeued>>

Prepare == /\ phase = "ready" /\ journal = "empty"
           /\ journal' = "prepared" /\ reserved' = TRUE
           /\ UNCHANGED <<phase, generation, pc, kind, requestGeneration,
                          observedPrepared, evidence, sends, inFlight, effects,
                          observations, timeouts, badDispatch, badDelivery,
                          badJournal, requeued>>

Capture(w, k) ==
    /\ phase = "ready" /\ pc[w] = "idle"
    /\ k \in {"read", "stream", "mutation", "status"}
    /\ (k # "mutation" \/ journal = "prepared")
    /\ (k # "status" \/ journal = "unknown")
    /\ pc' = [pc EXCEPT ![w] = "captured"]
    /\ kind' = [kind EXCEPT ![w] = k]
    /\ requestGeneration' = [requestGeneration EXCEPT ![w] = generation]
    /\ observedPrepared' = [observedPrepared EXCEPT ![w] = (k = "mutation")]
    /\ evidence' = [evidence EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<phase, generation, journal, reserved, sends, inFlight,
                   effects, observations, timeouts, badDispatch, badDelivery,
                   badJournal, requeued>>

DispatchRead(w) ==
    /\ pc[w] = "captured" /\ kind[w] # "mutation"
    /\ (BreakDispatchFence \/ GoodSession(w))
    /\ pc' = [pc EXCEPT ![w] = "waiting"]
    /\ badDispatch' = (badDispatch \/ ~GoodSession(w))
    /\ UNCHANGED <<phase, generation, kind, requestGeneration,
                   observedPrepared, evidence, journal, reserved, sends,
                   inFlight, effects, observations, timeouts, badDelivery,
                   badJournal, requeued>>

ClaimMutation(w) ==
    /\ pc[w] = "captured" /\ kind[w] = "mutation"
    /\ observedPrepared[w]
    /\ (BreakClaimCAS \/ journal = "prepared")
    /\ (BreakDispatchFence \/ GoodSession(w))
    /\ pc' = [pc EXCEPT ![w] = "claimed"]
    /\ journal' = IF BreakPersistBeforeSend THEN journal ELSE "unknown"
    /\ reserved' = TRUE
    /\ UNCHANGED <<phase, generation, kind, requestGeneration,
                   observedPrepared, evidence, sends, inFlight, effects,
                   observations, timeouts, badDispatch, badDelivery,
                   badJournal, requeued>>

SendMutation(w) ==
    /\ pc[w] = "claimed" /\ kind[w] = "mutation"
    /\ (BreakDispatchFence \/ GoodSession(w))
    /\ pc' = [pc EXCEPT ![w] = "waiting"]
    /\ sends' = sends + 1 /\ inFlight' = inFlight + 1
    /\ badDispatch' = (badDispatch \/ ~GoodSession(w))
    /\ badJournal' = (badJournal \/ journal # "unknown" \/ ~reserved)
    /\ UNCHANGED <<phase, generation, kind, requestGeneration,
                   observedPrepared, evidence, journal, reserved, effects,
                   observations, timeouts, badDelivery, requeued>>

AcceptRemote == /\ inFlight > 0
                /\ inFlight' = inFlight - 1 /\ effects' = effects + 1
                /\ UNCHANGED <<phase, generation, pc, kind, requestGeneration,
                               observedPrepared, evidence, journal, reserved,
                               sends, observations, timeouts, badDispatch,
                               badDelivery, badJournal, requeued>>

LoseRemote == /\ inFlight > 0
              /\ inFlight' = inFlight - 1
              /\ UNCHANGED <<phase, generation, pc, kind, requestGeneration,
                             observedPrepared, evidence, journal, reserved,
                             sends, effects, observations, timeouts,
                             badDispatch, badDelivery, badJournal, requeued>>

Return(w) ==
    /\ pc[w] = "waiting"
    /\ (kind[w] # "mutation" \/ effects > 0)
    /\ pc' = [pc EXCEPT ![w] = "response"]
    /\ evidence' = [evidence EXCEPT ![w] =
                     (kind[w] \in {"mutation", "status"} /\ effects > 0)]
    /\ UNCHANGED <<phase, generation, kind, requestGeneration,
                   observedPrepared, journal, reserved, sends, inFlight,
                   effects, observations, timeouts, badDispatch, badDelivery,
                   badJournal, requeued>>

Deliver(w) ==
    /\ pc[w] = "response"
    /\ (BreakDeliveryFence \/ GoodSession(w))
    /\ pc' = [pc EXCEPT ![w] = IF kind[w] = "stream" THEN "waiting" ELSE "idle"]
    /\ kind' = [kind EXCEPT ![w] = IF kind[w] = "stream" THEN "stream" ELSE "none"]
    /\ requestGeneration' = [requestGeneration EXCEPT ![w] =
                              IF kind[w] = "stream" THEN @ ELSE 0]
    /\ observedPrepared' = [observedPrepared EXCEPT ![w] = FALSE]
    /\ evidence' = [evidence EXCEPT ![w] = FALSE]
    /\ badDelivery' = (badDelivery \/ ~GoodSession(w))
    /\ journal' = IF evidence[w] THEN "confirmed" ELSE journal
    /\ reserved' = IF evidence[w] THEN FALSE ELSE reserved
    /\ UNCHANGED <<phase, generation, sends, inFlight, effects, observations, timeouts,
                   badDispatch, badJournal, requeued>>

Drop(w) ==
    /\ pc[w] # "idle"
    /\ pc' = [pc EXCEPT ![w] = "idle"]
    /\ kind' = [kind EXCEPT ![w] = "none"]
    /\ requestGeneration' = [requestGeneration EXCEPT ![w] = 0]
    /\ observedPrepared' = [observedPrepared EXCEPT ![w] = FALSE]
    /\ evidence' = [evidence EXCEPT ![w] = FALSE]
    /\ UNCHANGED <<phase, generation, journal, reserved, sends, inFlight,
                   effects, observations, timeouts, badDispatch, badDelivery,
                   badJournal, requeued>>

ObserveUnconfirmed ==
    /\ journal = "unknown" /\ effects = 0
    /\ observations < MaxObservations
    /\ observations' = observations + 1
    /\ reserved' = IF BreakUnknownRelease THEN FALSE ELSE reserved
    /\ UNCHANGED <<phase, generation, pc, kind, requestGeneration,
                   observedPrepared, evidence, journal, sends, inFlight,
                   effects, timeouts, badDispatch, badDelivery, badJournal,
                   requeued>>

TimeoutUnknown ==
    /\ journal = "unknown" /\ timeouts < MaxObservations
    /\ timeouts' = timeouts + 1
    /\ journal' = IF BreakUnknownReplay THEN "prepared" ELSE journal
    /\ requeued' = (requeued \/ BreakUnknownReplay)
    /\ UNCHANGED <<phase, generation, pc, kind, requestGeneration,
                   observedPrepared, evidence, reserved, sends, inFlight,
                   effects, observations, badDispatch, badDelivery, badJournal>>

Terminal == /\ generation = MaxGeneration /\ phase \in {"locked", "paused"}
            /\ UNCHANGED vars

Next == Unlock \/ Bootstrap \/ Pause \/ Lock \/ Crash \/ Resume \/ Prepare
        \/ AcceptRemote \/ LoseRemote \/ ObserveUnconfirmed \/ TimeoutUnknown
        \/ Terminal
        \/ \E w \in Workers :
             (\E k \in {"read", "stream", "mutation", "status"} : Capture(w, k))
             \/ DispatchRead(w) \/ ClaimMutation(w) \/ SendMutation(w)
             \/ Return(w) \/ Deliver(w) \/ Drop(w)

Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in Phases /\ generation \in 0..MaxGeneration
          /\ pc \in [Workers -> Stages] /\ kind \in [Workers -> Kinds]
          /\ requestGeneration \in [Workers -> 0..MaxGeneration]
          /\ observedPrepared \in [Workers -> BOOLEAN]
          /\ evidence \in [Workers -> BOOLEAN]
          /\ journal \in {"empty", "prepared", "unknown", "confirmed"}
          /\ reserved \in BOOLEAN
          /\ sends \in Nat /\ inFlight \in Nat /\ effects \in Nat
          /\ observations \in 0..MaxObservations
          /\ timeouts \in 0..MaxObservations
          /\ badDispatch \in BOOLEAN /\ badDelivery \in BOOLEAN
          /\ badJournal \in BOOLEAN /\ requeued \in BOOLEAN

NoOutOfSessionDispatch == ~badDispatch
NoStaleDelivery == ~badDelivery
AtMostOneMutation == sends <= 1
DispatchJournaled == ~badJournal
UnknownNeverRequeued == ~requeued
ReservedWhenUnresolved == journal \in {"prepared", "unknown"} => reserved
RemoteEffectsBounded == effects + inFlight <= sends
ConfirmationHasEvidence == journal = "confirmed" => effects > 0
====
