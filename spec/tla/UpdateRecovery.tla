---------------------------- MODULE UpdateRecovery ----------------------------
EXTENDS Naturals, FiniteSets

(* UIReconcile/ClickSettings: createAndroidUpdateController.reconcile/permission.
   HostSnapshot/RejectMissingFile: AndroidUpdates::snapshot_for/begin_install.
   PrepareRecord/PrecommitFailure/Commit: AndroidUpdater.install/info, AndroidUpdateJournal.
   QueueAuthorization/RunAuthorization/AuthorizationTimeout: AndroidUpdateAuthorization.run.
   TryAbandon/DropOwner: AndroidUpdatePolicy.afterAbandon, InstallOwner::drop.
   ReadInfo/ReplyInfo: native_android_update_info, AndroidUpdates::query_info/info_ticket/snapshot_for. *)

CONSTANTS MaxAttempts, BreakVersionGuard, BreakPermissionRetry, BreakKnownFailure,
    BreakAuthFence, BreakMissingFile, BreakAbandonFence, BreakAttemptFence, BreakInfoFence
VARIABLE s
vars == <<s>>
Target == 2
Attempts == 1..MaxAttempts
UIStates == {"available", "ready", "failed", "preparing", "installing", "unknown", "installed"}
HostStates == {"empty", "ready", "calling", "returned", "awaiting"}
NativeStates == {"idle", "claimed", "journaled", "committed", "failed"}
Records == {"idle", "installed", "preparing", "installing", "failed"}
Receipts == {"none", "failed", "rejected", "installing"}
Authorizations == {"none", "queued", "running", "cancelled", "completed"}
Waiters == {"none", "waiting", "known-failed", "ambiguous", "complete"}

Init ==
    \E rec \in {"idle", "installed", "failed"}, hasFile \in BOOLEAN, allowed \in BOOLEAN :
    /\ (rec = "failed" => hasFile)
    /\ \E hostState \in IF hasFile THEN {"ready", "returned"} ELSE {"empty"},
          uiState \in IF rec = "failed" THEN {"failed"}
            ELSE IF hasFile THEN {"ready", "unknown"} ELSE {"available"} :
       s = [installed |-> 1, latest |-> Target, record |-> rec,
            recordTarget |-> IF rec = "installed" THEN 1 ELSE IF rec = "failed" THEN Target ELSE 0,
            recordAttempt |-> 0, ui |-> uiState, host |-> hostState, native |-> "idle",
            file |-> hasFile, permission |-> allowed, settingsOpen |-> FALSE,
            ignoredSettings |-> FALSE, nextAttempt |-> 1, owner |-> 0,
            authorized |-> {}, committed |-> {}, receipt |-> "none", delivered |-> FALSE,
            knownFailure |-> FALSE, knownReceipt |-> FALSE, reconciled |-> FALSE,
            journaledCommit |-> TRUE, staleRemoval |-> FALSE, missingObserved |-> FALSE,
            missingReceipt |-> FALSE, authorization |-> "none", waiter |-> "none",
            ranCancelled |-> FALSE, unresolved |-> FALSE, abandonTried |-> FALSE,
            ownerDrops |-> {}, retiredRelease |-> FALSE,
            stageEpoch |-> IF hasFile THEN 1 ELSE 0, queryState |-> "idle",
            queryTicket |-> <<"empty", 0, 0>>, queryRecord |-> "idle",
            queryInstalled |-> 1, staleInfoMutation |-> FALSE]

Pending == (s.record = "installing" /\ ~s.knownReceipt)
    \/ s.authorization \in {"queued", "running"} \/ s.native = "committed"

Stage ==
    /\ ~s.file /\ s.host = "empty" /\ ~Pending /\ s.latest = Target
    /\ s.installed < Target /\ s.ui \in {"available", "failed"} /\ s.stageEpoch < 2
    /\ s' = [s EXCEPT !.file = TRUE, !.host = "ready", !.ui = "ready",
        !.missingReceipt = FALSE, !.missingObserved = FALSE, !.stageEpoch = @ + 1]

AdvanceLatest ==
    /\ s.latest = Target
    /\ s' = [s EXCEPT !.latest = 3, !.reconciled = FALSE,
        !.ui = IF @ = "installed" THEN "available" ELSE @]

UIReconcile ==
    /\ s.ui # "preparing"
    /\ LET selected == IF s.file \/ s.ui \in {"installing", "unknown"} THEN Target ELSE s.latest
       IN s' = [s EXCEPT !.reconciled = TRUE,
          !.ui = IF s.missingReceipt \/ s.knownReceipt THEN "failed"
            ELSE IF s.record = "installed" /\ BreakVersionGuard THEN "installed"
            ELSE IF s.record = "installed" /\ s.installed >= selected
                THEN IF s.latest > s.installed THEN "available" ELSE "installed"
            ELSE IF s.record = "installing" THEN "installing"
            ELSE IF s.record = "failed" THEN "failed"
            ELSE IF @ \in {"installing", "unknown"} THEN "unknown"
            ELSE IF s.file THEN "ready" ELSE "available"]

HostSnapshot ==
    /\ s.host \in {"ready", "returned", "awaiting"}
    /\ LET completed == s.record = "installed" /\ (s.installed >= Target \/ BreakVersionGuard)
           missing == ~s.file /\ ~Pending /\ ~completed
       IN s' = [s EXCEPT
          !.host = IF missing /\ ~BreakMissingFile THEN "empty"
            ELSE IF completed THEN "empty"
            ELSE IF Pending THEN "awaiting" ELSE "ready",
          !.file = IF completed THEN FALSE ELSE @,
          !.staleRemoval = @ \/ (completed /\ s.installed < Target /\ s.file),
          !.missingObserved = @ \/ missing,
          !.missingReceipt = @ \/ (missing /\ ~BreakMissingFile)]

CacheEvict ==
    /\ s.file
    /\ s' = [s EXCEPT !.file = FALSE, !.missingObserved = FALSE, !.reconciled = FALSE]

RejectMissingFile ==
    /\ ~s.file /\ s.host = "ready" /\ ~Pending
    /\ s.ui \in {"ready", "failed"} /\ s.permission
    /\ s' = [s EXCEPT !.missingObserved = TRUE,
        !.host = IF BreakMissingFile THEN @ ELSE "empty",
        !.missingReceipt = ~BreakMissingFile,
        !.ui = IF BreakMissingFile THEN @ ELSE "failed"]

PermissionOffered == s.file /\ ~s.permission /\
    (s.ui = "ready" \/ (s.ui = "failed" /\ (s.record = "failed" \/ s.knownReceipt)))
ClickSettings ==
    /\ PermissionOffered /\ ~s.settingsOpen
    /\ LET accepted == s.ui = "ready"
            \/ (~BreakPermissionRetry /\ s.ui = "failed" /\ (s.record = "failed" \/ s.knownReceipt))
       IN s' = [s EXCEPT !.settingsOpen = accepted, !.ignoredSettings = ~accepted]

ReturnSettings ==
    /\ s.settingsOpen
    /\ s' = [s EXCEPT !.settingsOpen = FALSE, !.permission = TRUE]

Claim ==
    /\ s.file /\ s.host = "ready" /\ s.permission /\ ~s.settingsOpen /\ ~Pending
    /\ s.installed < Target /\ s.ui \in {"ready", "failed"} /\ s.nextAttempt \in Attempts
    /\ s' = [s EXCEPT !.owner = s.nextAttempt, !.nextAttempt = @ + 1,
        !.authorized = @ \cup {s.nextAttempt}, !.ui = "preparing", !.host = "calling",
        !.native = "claimed", !.receipt = "none", !.delivered = FALSE,
        !.knownFailure = FALSE, !.knownReceipt = FALSE, !.reconciled = FALSE,
        !.authorization = "none", !.waiter = "none"]

PrepareRecord ==
    /\ s.native = "claimed" /\ s.receipt = "none"
    /\ s' = [s EXCEPT !.record = "preparing", !.recordTarget = Target,
        !.recordAttempt = s.owner, !.native = "journaled"]

PrecommitFailure(persist) ==
    /\ s.native \in {"claimed", "journaled"} /\ s.receipt = "none"
    /\ s.authorization = "none" /\ s.owner \notin s.committed
    /\ LET writeFailure == persist /\ (~BreakKnownFailure \/ s.recordAttempt = s.owner)
       IN s' = [s EXCEPT !.record = IF writeFailure THEN "failed" ELSE @,
          !.recordTarget = IF writeFailure THEN Target ELSE @,
          !.recordAttempt = IF writeFailure THEN s.owner ELSE @,
          !.receipt = IF BreakKnownFailure THEN "rejected" ELSE "failed",
          !.native = "failed", !.knownFailure = TRUE, !.knownReceipt = ~BreakKnownFailure]

QueueAuthorization ==
    /\ s.native = "journaled" /\ s.receipt = "none" /\ s.permission
    /\ s.record = "preparing" /\ s.recordTarget = Target /\ s.recordAttempt = s.owner
    /\ s.authorization = "none"
    /\ s' = [s EXCEPT !.record = "installing", !.authorization = "queued", !.waiter = "waiting"]

RunAuthorization ==
    /\ s.authorization = "queued" \/ (BreakAuthFence /\ s.authorization = "cancelled")
    /\ s' = [s EXCEPT !.authorization = "running",
        !.ranCancelled = @ \/ s.authorization = "cancelled"]

AuthorizationTimeout(persist) ==
    /\ s.waiter = "waiting" /\ s.authorization \in {"queued", "running"}
    /\ IF s.authorization = "queued"
       THEN s' = [s EXCEPT !.authorization = "cancelled", !.waiter = "known-failed",
            !.native = "failed", !.record = IF persist THEN "failed" ELSE @, !.receipt = "failed",
            !.knownFailure = TRUE, !.knownReceipt = TRUE]
       ELSE s' = [s EXCEPT !.waiter = "ambiguous", !.receipt = "rejected", !.unresolved = TRUE]

Commit ==
    /\ s.native = "journaled" /\ s.authorization = "running"
    /\ s.record = "installing" /\ s.recordTarget = Target /\ s.recordAttempt = s.owner
    /\ s.owner \in s.authorized /\ s.owner \notin s.committed
    /\ s' = [s EXCEPT !.committed = @ \cup {s.owner}, !.native = "committed",
        !.authorization = "completed", !.waiter = IF @ = "ambiguous" THEN @ ELSE "complete",
        !.receipt = IF s.waiter = "ambiguous" THEN "rejected" ELSE "installing",
        !.journaledCommit = (s.record = "installing" /\ s.recordTarget = Target /\ s.recordAttempt = s.owner),
        !.unresolved = TRUE]

PostcommitLoss ==
    /\ s.native = "committed" /\ s.receipt = "installing" /\ ~s.delivered
    /\ s' = [s EXCEPT !.receipt = "rejected"]

Deliver ==
    /\ s.receipt # "none" /\ ~s.delivered
    /\ s' = [s EXCEPT !.delivered = TRUE, !.host = "returned", !.reconciled = FALSE,
        !.ownerDrops = @ \cup {s.owner},
        !.ui = CASE s.receipt = "failed" -> "failed"
            [] s.receipt = "installing" -> "installing" [] OTHER -> "unknown"]

OSComplete ==
    /\ s.native = "committed" /\ s.owner \in s.committed
    /\ s' = [s EXCEPT !.installed = Target, !.record = "installed",
        !.recordTarget = Target, !.native = "idle", !.reconciled = FALSE, !.unresolved = FALSE]

OSFailure ==
    /\ s.native = "committed" /\ s.owner \in s.committed
    /\ s' = [s EXCEPT !.record = "failed", !.native = "failed", !.unresolved = FALSE]

TryAbandon(succeeded, absent) ==
    /\ s.unresolved /\ s.native = "committed" /\ s.delivered /\ s.authorization = "completed"
    /\ LET released == succeeded /\ absent
       IN s' = [s EXCEPT !.abandonTried = TRUE,
          !.record = IF released \/ BreakAbandonFence THEN "failed" ELSE @,
          !.native = IF released \/ BreakAbandonFence THEN "failed" ELSE @,
          !.unresolved = IF released THEN FALSE ELSE @]

DropOwner(attempt) ==
    /\ attempt \in s.ownerDrops
    /\ LET stale == attempt # s.owner /\ s.host = "calling"
       IN s' = [s EXCEPT !.ownerDrops = @ \ {attempt},
          !.host = IF stale /\ BreakAttemptFence THEN "returned" ELSE @,
          !.retiredRelease = @ \/ (stale /\ BreakAttemptFence)]

InfoTicket == <<IF s.host = "awaiting" THEN "returned" ELSE s.host,
    IF s.host = "empty" THEN 0 ELSE s.stageEpoch,
    IF s.host \in {"calling", "returned", "awaiting"} THEN s.owner ELSE 0>>

ReadInfo ==
    /\ s.queryState = "idle"
    /\ s.owner = 0 \/ (s.owner = 1 /\ s.host = "calling")
    /\ s' = [s EXCEPT !.queryState = "pending", !.queryTicket = InfoTicket,
        !.queryRecord = IF s.knownReceipt THEN "failed"
            ELSE IF s.record = "preparing" THEN "installing" ELSE s.record,
        !.queryInstalled = s.installed]

ReplyInfo ==
    /\ s.queryState = "pending"
    /\ LET same == s.queryTicket = InfoTicket
           eligible == s.host \in {"ready", "returned", "awaiting"}
           completed == s.queryRecord = "installed" /\ s.queryInstalled >= Target
           pending == s.queryRecord = "installing"
           missing == ~s.file /\ ~pending /\ ~completed
           nextHost == IF missing THEN "empty" ELSE IF completed THEN "empty"
                ELSE IF pending THEN "awaiting" ELSE "ready"
           nextFile == IF completed THEN FALSE ELSE s.file
           writes == nextHost # s.host \/ nextFile # s.file
                \/ (missing /\ ~s.missingReceipt)
       IN IF eligible /\ (same \/ BreakInfoFence)
          THEN s' = [s EXCEPT !.queryState = "done", !.host = nextHost,
              !.file = nextFile, !.missingObserved = @ \/ missing,
              !.missingReceipt = @ \/ missing,
              !.staleInfoMutation = @ \/ (~same /\ writes)]
          ELSE s' = [s EXCEPT !.queryState = "done"]

Next == Stage \/ AdvanceLatest \/ UIReconcile \/ HostSnapshot \/ CacheEvict
    \/ RejectMissingFile \/ ClickSettings \/ ReturnSettings \/ Claim \/ PrepareRecord
    \/ (\E persist \in BOOLEAN : PrecommitFailure(persist))
    \/ QueueAuthorization \/ RunAuthorization \/ (\E persist \in BOOLEAN : AuthorizationTimeout(persist)) \/ Commit
    \/ PostcommitLoss \/ Deliver \/ OSComplete \/ OSFailure
    \/ (\E succeeded, absent \in BOOLEAN : TryAbandon(succeeded, absent))
    \/ (\E attempt \in Attempts : DropOwner(attempt))
    \/ ReadInfo \/ ReplyInfo

TypeOK == s \in [installed: 1..Target, latest: Target..3, record: Records,
    recordTarget: 0..Target, recordAttempt: Attempts \cup {0}, ui: UIStates,
    host: HostStates, native: NativeStates, file: BOOLEAN, permission: BOOLEAN,
    settingsOpen: BOOLEAN, ignoredSettings: BOOLEAN, nextAttempt: 1..(MaxAttempts + 1),
    owner: Attempts \cup {0}, authorized: SUBSET Attempts, committed: SUBSET Attempts,
    receipt: Receipts, delivered: BOOLEAN, knownFailure: BOOLEAN, knownReceipt: BOOLEAN,
    reconciled: BOOLEAN, journaledCommit: BOOLEAN, staleRemoval: BOOLEAN,
    missingObserved: BOOLEAN, missingReceipt: BOOLEAN, authorization: Authorizations,
    waiter: Waiters, ranCancelled: BOOLEAN, unresolved: BOOLEAN, abandonTried: BOOLEAN,
    ownerDrops: SUBSET Attempts, retiredRelease: BOOLEAN, stageEpoch: 0..2,
    queryState: {"idle", "pending", "done"},
    queryTicket: HostStates \X (0..2) \X (Attempts \cup {0}),
    queryRecord: Records, queryInstalled: 1..Target, staleInfoMutation: BOOLEAN]
NoStaleInfoMutation == ~s.staleInfoMutation
NoStaleInstalledCompletion == (s.ui = "installed" => s.installed >= Target) /\ ~s.staleRemoval
NoIgnoredPermissionAction == ~s.ignoredSettings
NoStrandedKnownFailure == (s.knownFailure /\ s.delivered /\ s.reconciled) => s.ui # "unknown"
NoAutomaticCommit == s.committed \subseteq s.authorized
CommitJournaled == s.journaledCommit
LatestAfterOwnedCompletion ==
    (s.reconciled /\ s.record = "installed" /\ s.installed >= Target /\ s.latest > s.installed) => s.ui = "available"
NoCancelledAuthorization == ~s.ranCancelled
AmbiguousAuthorizationRetained == (s.authorization = "running" /\ s.waiter = "ambiguous") =>
    s.native = "journaled" /\ s.record = "installing" /\ s.host \notin {"ready", "empty"}
NoReadyMissingFile == s.missingObserved => s.host # "ready" /\ (s.reconciled => s.ui # "ready")
NoRetryWithUnresolvedSession == s.unresolved => Pending
NoRetiredOwnerChangesNewAttempt == ~s.retiredRelease
Spec == Init /\ [][Next]_vars
=============================================================================
