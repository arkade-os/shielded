---- MODULE PoolSpendJournal ----
EXTENDS Naturals

CONSTANTS MaxClock, MaxBatches,
          BreakGrace, BreakTrackedWindow, BreakForeignRefusal, BreakEdgeRefusal,
          BreakRetention, BreakCoinProof, BreakForceWindow, BreakForceVerdict

VARIABLES journal, inFlight, answer, pool, tracked, clock, batches, seen,
          batchAt, marked, deposit, coinSpent, freed, retry, paid, stranded

vars == <<journal, inFlight, answer, pool, tracked, clock, batches, seen,
          batchAt, marked, deposit, coinSpent, freed, retry, paid, stranded>>

Journals == {"none", "open", "gone"}
Answers == {"none", "edge429", "pool429", "foreign429", "accepted", "lost", "handled"}
Pools == {"none", "admitted", "landed", "dropped"}
Retries == {"none", "dispatched", "admitted", "landed"}

\* Clock 0 is inside the grace, 1 past it and inside the pool's tracking hour, 2 past both.
Grace == 1
Retention == 2

CanLand == tracked /\ pool \in {"admitted", "dropped"}
IdAnswer == IF ~tracked \/ pool = "none" THEN "missing"
            ELSE IF pool = "admitted" THEN "pending"
            ELSE IF pool = "landed" THEN "included" ELSE "dropped"
\* A deposit spends no note of ours, so the account's history never carries one and only its coin answers.
Verdict == IF deposit THEN (IF pool = "landed" THEN "landed" ELSE "nothing")
           ELSE IF seen # batches THEN "unknown"
           ELSE IF pool = "landed" THEN "landed" ELSE "nothing"
NewBatchAt == IF marked THEN batchAt ELSE seen
\* What a pass must release: a deposit past the pool's retention whatever its coin says, since the coin bounds what a retry can do; a note spend only once it is proven dead on a current view.
SettleProven == IF deposit THEN clock >= Retention
                ELSE /\ ~inFlight /\ pool # "landed" /\ ~CanLand /\ clock >= Retention
                     /\ seen = batches /\ seen # NewBatchAt
RefusalProven == pool = "none" /\ ~inFlight

Init == /\ journal = "none" /\ inFlight = FALSE /\ answer = "none"
        /\ pool = "none" /\ tracked = TRUE
        /\ clock = 0 /\ batches = 0 /\ seen = 0
        /\ batchAt = 0 /\ marked = FALSE
        /\ deposit \in BOOLEAN
        /\ coinSpent = FALSE /\ freed = FALSE /\ retry = "none" /\ paid = 0 /\ stranded = FALSE

Reserve == /\ journal = "none" /\ answer = "none" /\ ~inFlight
           /\ journal' = "open"
           /\ UNCHANGED <<inFlight, answer, pool, tracked, clock, batches, seen,
                          batchAt, marked, deposit, coinSpent, freed, retry, paid, stranded>>

\* beforeNativeMutation stamps createdAt in the same fetch call that sends, so a POST leaves inside its grace or never.
Dispatch == /\ journal = "open" /\ answer = "none" /\ ~inFlight /\ clock = 0
            /\ inFlight' = TRUE
            /\ UNCHANGED <<journal, answer, pool, tracked, clock, batches, seen,
                           batchAt, marked, deposit, coinSpent, freed, retry, paid, stranded>>

Answered(reply) ==
    /\ inFlight /\ inFlight' = FALSE /\ answer' = reply
    /\ UNCHANGED <<journal, tracked, clock, batches, seen, batchAt,
                   marked, deposit, coinSpent, freed, retry, paid, stranded>>

\* The edge rate limit and the gateway's admit() both refuse before they forward, so the pool never saw it.
EdgeRefuse == /\ pool = "none" /\ Answered("edge429") /\ UNCHANGED pool
PoolRefuse == /\ pool = "none" /\ Answered("pool429") /\ UNCHANGED pool
\* A 429 in neither shape: some hop answered, and it may already have forwarded.
ForeignRefuseUnseen == /\ pool = "none" /\ Answered("foreign429") /\ UNCHANGED pool
ForeignRefuseSeen == /\ pool = "none" /\ Answered("foreign429") /\ pool' = "admitted"
Accept == /\ pool = "none" /\ Answered("accepted") /\ pool' = "admitted"
AcceptLost == /\ pool = "none" /\ Answered("lost") /\ pool' = "admitted"
LoseUnseen == /\ pool = "none" /\ Answered("lost") /\ UNCHANGED pool

\* A deposit's batch spends its one coin, so a coin already spent is a slot that can never land.
Batched(from) ==
    /\ pool = from /\ tracked /\ batches < MaxBatches /\ (~deposit \/ ~coinSpent)
    /\ pool' = "landed" /\ batches' = batches + 1
    /\ paid' = paid + 1 /\ coinSpent' = (coinSpent \/ deposit)
    /\ UNCHANGED <<journal, inFlight, answer, tracked, clock, seen,
                   batchAt, marked, deposit, freed, retry, stranded>>

Land == Batched("admitted")
\* The operator takes a drop back when an abandoned batch lands after all, while it still tracks the spend.
Reinclude == Batched("dropped")
PoolDrop == /\ pool = "admitted" /\ pool' = "dropped"
            /\ UNCHANGED <<journal, inFlight, answer, tracked, clock, batches,
                           seen, batchAt, marked, deposit, coinSpent, freed, retry, paid, stranded>>

OtherBatch == /\ batches < MaxBatches /\ batches' = batches + 1
              /\ UNCHANGED <<journal, inFlight, answer, pool, tracked, clock, seen,
                             batchAt, marked, deposit, coinSpent, freed, retry, paid, stranded>>

\* What the wallet does with funds it believes are free. A deposit is rebuilt on the same coin; a note spend can be rebuilt on other notes, and two of those can both land.
RetryDispatch == /\ journal = "gone" /\ freed /\ retry = "none" /\ retry' = "dispatched"
                 /\ UNCHANGED <<journal, inFlight, answer, pool, tracked, clock, batches,
                                seen, batchAt, marked, deposit, coinSpent, freed, paid, stranded>>
RetryAdmit == /\ retry = "dispatched" /\ retry' = "admitted"
              /\ UNCHANGED <<journal, inFlight, answer, pool, tracked, clock, batches,
                             seen, batchAt, marked, deposit, coinSpent, freed, paid, stranded>>
RetryLand == /\ retry = "admitted" /\ (~deposit \/ ~coinSpent) /\ batches < MaxBatches
             /\ retry' = "landed" /\ batches' = batches + 1
             /\ paid' = paid + 1 /\ coinSpent' = (coinSpent \/ deposit)
             /\ UNCHANGED <<journal, inFlight, answer, pool, tracked, clock, seen,
                            batchAt, marked, deposit, freed, stranded>>

\* The grace covers the longest a POST can be in flight, so one cannot outlive it.
Tick == /\ clock < MaxClock /\ ~inFlight
        /\ clock' = clock + 1
        /\ tracked' = IF clock + 1 >= Retention THEN FALSE ELSE tracked
        /\ UNCHANGED <<journal, inFlight, answer, pool, batches, seen,
                       batchAt, marked, deposit, coinSpent, freed, retry, paid, stranded>>

\* An idle pool never raises batches; a wallet behind the count it reads gives no verdict at all.
Catchup == /\ seen # batches /\ seen' = batches
           /\ UNCHANGED <<journal, inFlight, answer, pool, tracked, clock, batches,
                          batchAt, marked, deposit, coinSpent, freed, retry, paid, stranded>>

Observe(reply, release) ==
    /\ journal = "open" /\ answer = reply
    /\ answer' = "handled"
    /\ journal' = IF release THEN "gone" ELSE "open"
    /\ freed' = (freed \/ release)
    /\ stranded' = (stranded \/ (~release /\ RefusalProven /\ reply = "edge429"))
    /\ UNCHANGED <<inFlight, pool, tracked, clock, batches, seen,
                   batchAt, marked, deposit, coinSpent, retry, paid>>

ObserveEdgeRefusal == Observe("edge429", ~BreakEdgeRefusal)
ObserveForeignRefusal == Observe("foreign429", BreakForeignRefusal)
ObservePoolRefusal == Observe("pool429", TRUE)
ObserveOutcome == \E reply \in {"accepted", "lost"} : Observe(reply, FALSE)

\* The pool forgets a spend an hour after admitting it, so past that hour a 404 no longer tells an arrival from a landing.
ReconcileId ==
    /\ journal = "open"
    /\ LET release == \/ IdAnswer = "included"
                      \/ /\ IdAnswer = "missing"
                         /\ (BreakGrace \/ clock >= Grace)
                         /\ (BreakTrackedWindow \/ clock < Retention)
       IN /\ journal' = IF release THEN "gone" ELSE "open"
          /\ freed' = (freed \/ (release /\ IdAnswer = "missing"))
    /\ UNCHANGED <<inFlight, answer, pool, tracked, clock, batches, seen,
                   batchAt, marked, deposit, coinSpent, retry, paid, stranded>>

Settle ==
    /\ journal = "open"
    /\ LET dead == Verdict = "nothing"
           noted == dead /\ ~deposit
           release == \/ Verdict = "landed"
                      \/ /\ dead
                         /\ (BreakRetention \/ clock >= Retention)
                         /\ ((deposit /\ ~BreakCoinProof) \/ seen # NewBatchAt)
       IN /\ journal' = IF release THEN "gone" ELSE "open"
          /\ freed' = (freed \/ (release /\ Verdict # "landed"))
          /\ stranded' = (stranded \/ (~release /\ SettleProven))
          /\ batchAt' = IF noted THEN NewBatchAt ELSE batchAt
          /\ marked' = (marked \/ noted)
    /\ UNCHANGED <<inFlight, answer, pool, tracked, clock, batches, seen,
                   deposit, coinSpent, retry, paid>>

\* The user's own release from the banner: a deposit at any age, since its coin bounds what a retry can do; a note spend only once the pool can no longer include it and this wallet, caught up, has no row for it.
ForceRelease ==
    /\ journal = "open"
    /\ LET free == \/ deposit
                   \/ /\ (BreakForceWindow \/ clock >= Retention)
                      /\ (BreakForceVerdict \/ Verdict = "nothing")
       IN /\ journal' = IF free THEN "gone" ELSE "open"
          /\ freed' = (freed \/ free)
    /\ UNCHANGED <<inFlight, answer, pool, tracked, clock, batches, seen,
                   batchAt, marked, deposit, coinSpent, retry, paid, stranded>>

Terminal == clock = MaxClock /\ ~inFlight /\ UNCHANGED vars

Next == \/ Reserve \/ Dispatch
        \/ EdgeRefuse \/ PoolRefuse \/ ForeignRefuseUnseen \/ ForeignRefuseSeen
        \/ Accept \/ AcceptLost \/ LoseUnseen
        \/ Land \/ Reinclude \/ PoolDrop \/ OtherBatch \/ Tick \/ Catchup
        \/ RetryDispatch \/ RetryAdmit \/ RetryLand
        \/ ObserveEdgeRefusal \/ ObserveForeignRefusal \/ ObservePoolRefusal
        \/ ObserveOutcome \/ ReconcileId \/ Settle \/ ForceRelease
        \/ Terminal

Spec == Init /\ [][Next]_vars

TypeOK == /\ journal \in Journals /\ inFlight \in BOOLEAN /\ answer \in Answers
          /\ pool \in Pools /\ tracked \in BOOLEAN
          /\ clock \in 0..MaxClock /\ batches \in 0..MaxBatches /\ seen \in 0..MaxBatches
          /\ batchAt \in 0..MaxBatches /\ marked \in BOOLEAN
          /\ deposit \in BOOLEAN /\ coinSpent \in BOOLEAN /\ freed \in BOOLEAN /\ retry \in Retries
          /\ paid \in 0..2 /\ stranded \in BOOLEAN

\* These funds are never paid twice: a first attempt and a retry after a release cannot both land.
NoDoublePayment == paid <= 1
\* A reservation a pass could release is released by that pass.
NoStrandedReservation == ~stranded
====
