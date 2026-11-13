---- MODULE PoolSpendJournal ----
EXTENDS Naturals

CONSTANTS MaxClock, MaxBatches,
          BreakGrace, BreakTrackedWindow, BreakForeignRefusal, BreakEdgeRefusal,
          BreakRetention, BreakCoinProof, BreakCoinSpentCheck

VARIABLES journal, inFlight, answer, pool, tracked, clock, batches, seen,
          batchAt, marked, deposit, falseDeath, stranded

vars == <<journal, inFlight, answer, pool, tracked, clock, batches, seen,
          batchAt, marked, deposit, falseDeath, stranded>>

Journals == {"none", "open", "gone"}
Answers == {"none", "edge429", "pool429", "foreign429", "accepted", "lost", "handled"}
Pools == {"none", "admitted", "landed", "dropped"}

\* Clock 0 is inside the grace, 1 past it and inside the pool's tracking hour, 2 past both.
Grace == 1
Retention == 2

CanLand == tracked /\ pool \in {"admitted", "dropped"}
IdAnswer == IF ~tracked \/ pool = "none" THEN "missing"
            ELSE IF pool = "admitted" THEN "pending"
            ELSE IF pool = "landed" THEN "included" ELSE "dropped"
\* A deposit spends no note of ours, so the account's history never carries one and only its coin answers.
Verdict == IF deposit
           THEN IF ~BreakCoinSpentCheck
                THEN (IF pool = "landed" THEN "landed" ELSE "nothing")
                ELSE IF seen # batches THEN "unknown" ELSE "nothing"
           ELSE IF seen # batches THEN "unknown"
           ELSE IF pool = "landed" THEN "landed" ELSE "nothing"
NewBatchAt == IF marked THEN batchAt ELSE seen
\* What a settle pass can prove dead: nothing in flight, nothing landed, nothing left that can land, and a proof it can read.
SettleProven == /\ ~inFlight /\ pool # "landed" /\ ~CanLand /\ clock >= Retention
                /\ (deposit \/ (seen = batches /\ seen # NewBatchAt))
RefusalProven == pool = "none" /\ ~inFlight
Doomed(release) == release /\ (inFlight \/ CanLand \/ pool = "landed")

Init == /\ journal = "none" /\ inFlight = FALSE /\ answer = "none"
        /\ pool = "none" /\ tracked = TRUE
        /\ clock = 0 /\ batches = 0 /\ seen = 0
        /\ batchAt = 0 /\ marked = FALSE
        /\ deposit \in BOOLEAN
        /\ falseDeath = FALSE /\ stranded = FALSE

Reserve == /\ journal = "none" /\ answer = "none" /\ ~inFlight
           /\ journal' = "open"
           /\ UNCHANGED <<inFlight, answer, pool, tracked, clock, batches, seen,
                          batchAt, marked, deposit, falseDeath, stranded>>

\* beforeNativeMutation stamps createdAt in the same fetch call that sends, so a POST leaves inside its grace or never.
Dispatch == /\ journal = "open" /\ answer = "none" /\ ~inFlight /\ clock = 0
            /\ inFlight' = TRUE
            /\ UNCHANGED <<journal, answer, pool, tracked, clock, batches, seen,
                           batchAt, marked, deposit, falseDeath, stranded>>

Answered(reply) ==
    /\ inFlight /\ inFlight' = FALSE /\ answer' = reply
    /\ UNCHANGED <<journal, tracked, clock, batches, seen, batchAt,
                   marked, deposit, falseDeath, stranded>>

\* The edge rate limit and the gateway's admit() both refuse before they forward, so the pool never saw it.
EdgeRefuse == /\ pool = "none" /\ Answered("edge429") /\ UNCHANGED pool
PoolRefuse == /\ pool = "none" /\ Answered("pool429") /\ UNCHANGED pool
\* A 429 in neither shape: some hop answered, and it may already have forwarded.
ForeignRefuseUnseen == /\ pool = "none" /\ Answered("foreign429") /\ UNCHANGED pool
ForeignRefuseSeen == /\ pool = "none" /\ Answered("foreign429") /\ pool' = "admitted"
Accept == /\ pool = "none" /\ Answered("accepted") /\ pool' = "admitted"
AcceptLost == /\ pool = "none" /\ Answered("lost") /\ pool' = "admitted"
LoseUnseen == /\ pool = "none" /\ Answered("lost") /\ UNCHANGED pool

Batched(from, to) ==
    /\ pool = from /\ tracked /\ batches < MaxBatches
    /\ pool' = to /\ batches' = batches + 1
    /\ UNCHANGED <<journal, inFlight, answer, tracked, clock, seen,
                   batchAt, marked, deposit, falseDeath, stranded>>

Land == Batched("admitted", "landed")
\* The operator takes a drop back when an abandoned batch lands after all, while it still tracks the spend.
Reinclude == Batched("dropped", "landed")
PoolDrop == /\ pool = "admitted" /\ pool' = "dropped"
            /\ UNCHANGED <<journal, inFlight, answer, tracked, clock, batches,
                           seen, batchAt, marked, deposit, falseDeath, stranded>>

OtherBatch == /\ batches < MaxBatches /\ batches' = batches + 1
              /\ UNCHANGED <<journal, inFlight, answer, pool, tracked, clock, seen,
                             batchAt, marked, deposit, falseDeath, stranded>>

\* The grace covers the longest a POST can be in flight, so one cannot outlive it.
Tick == /\ clock < MaxClock /\ ~inFlight
        /\ clock' = clock + 1
        /\ tracked' = IF clock + 1 >= Retention THEN FALSE ELSE tracked
        /\ UNCHANGED <<journal, inFlight, answer, pool, batches, seen,
                       batchAt, marked, deposit, falseDeath, stranded>>

\* An idle pool never raises batches; a wallet behind the count it reads gives no verdict at all.
Catchup == /\ seen # batches /\ seen' = batches
           /\ UNCHANGED <<journal, inFlight, answer, pool, tracked, clock, batches,
                          batchAt, marked, deposit, falseDeath, stranded>>

Observe(reply, release) ==
    /\ journal = "open" /\ answer = reply
    /\ answer' = "handled"
    /\ journal' = IF release THEN "gone" ELSE "open"
    /\ falseDeath' = (falseDeath \/ Doomed(release))
    /\ stranded' = (stranded \/ (~release /\ RefusalProven /\ reply = "edge429"))
    /\ UNCHANGED <<inFlight, pool, tracked, clock, batches, seen,
                   batchAt, marked, deposit>>

ObserveEdgeRefusal == Observe("edge429", ~BreakEdgeRefusal)
ObserveForeignRefusal == Observe("foreign429", BreakForeignRefusal)
ObservePoolRefusal == Observe("pool429", TRUE)
ObserveOutcome == \E reply \in {"accepted", "lost"} : Observe(reply, FALSE)

\* The pool forgets a spend an hour after admitting it, so past that hour a 404 no longer tells an arrival from a landing.
ReconcileId ==
    /\ journal = "open"
    /\ LET missing == IdAnswer = "missing"
           release == \/ IdAnswer = "included"
                      \/ /\ missing
                         /\ (BreakGrace \/ clock >= Grace)
                         /\ (BreakTrackedWindow \/ clock < Retention)
       IN /\ journal' = IF release THEN "gone" ELSE "open"
          /\ falseDeath' = (falseDeath \/ Doomed(missing /\ release))
    /\ UNCHANGED <<inFlight, answer, pool, tracked, clock, batches, seen,
                   batchAt, marked, deposit, stranded>>

Settle ==
    /\ journal = "open"
    /\ LET dead == Verdict = "nothing"
           release == \/ Verdict = "landed"
                      \/ /\ dead
                         /\ (BreakRetention \/ clock >= Retention)
                         /\ ((deposit /\ ~BreakCoinProof) \/ seen # NewBatchAt)
       IN /\ journal' = IF release THEN "gone" ELSE "open"
          /\ falseDeath' = (falseDeath \/ Doomed(dead /\ release))
          /\ stranded' = (stranded \/ (~release /\ SettleProven))
          /\ batchAt' = IF dead THEN NewBatchAt ELSE batchAt
          /\ marked' = (marked \/ dead)
    /\ UNCHANGED <<inFlight, answer, pool, tracked, clock, batches, seen, deposit>>

Terminal == clock = MaxClock /\ ~inFlight /\ UNCHANGED vars

Next == \/ Reserve \/ Dispatch
        \/ EdgeRefuse \/ PoolRefuse \/ ForeignRefuseUnseen \/ ForeignRefuseSeen
        \/ Accept \/ AcceptLost \/ LoseUnseen
        \/ Land \/ Reinclude \/ PoolDrop \/ OtherBatch \/ Tick \/ Catchup
        \/ ObserveEdgeRefusal \/ ObserveForeignRefusal \/ ObservePoolRefusal
        \/ ObserveOutcome \/ ReconcileId \/ Settle
        \/ Terminal

Spec == Init /\ [][Next]_vars

TypeOK == /\ journal \in Journals /\ inFlight \in BOOLEAN /\ answer \in Answers
          /\ pool \in Pools /\ tracked \in BOOLEAN
          /\ clock \in 0..MaxClock /\ batches \in 0..MaxBatches /\ seen \in 0..MaxBatches
          /\ batchAt \in 0..MaxBatches /\ marked \in BOOLEAN
          /\ deposit \in BOOLEAN /\ falseDeath \in BOOLEAN /\ stranded \in BOOLEAN

\* No release of a reservation while its payment is in flight, can still land, or already landed.
NoDoublePayment == ~falseDeath
DispatchJournaled == inFlight => journal = "open"
\* A reservation a pass could prove dead is released by that pass.
NoStrandedReservation == ~stranded
====
