VIOLATED NoStaleDelivery, 8 states

| # | action | changed |
|---|---|---|
| 1 | Initial | phase = "locked"<br>observations = 0<br>badJournal = FALSE<br>requestGeneration = (w1 :> 0 @@ w2 :> 0)<br>timeouts = 0<br>badDelivery = FALSE<br>journal = "empty"<br>pc = (w1 :> "idle" @@ w2 :> "idle")<br>badDispatch = FALSE<br>kind = (w1 :> "none" @@ w2 :> "none")<br>reserved = FALSE<br>generation = 0<br>inFlight = 0<br>evidence = (w1 :> FALSE @@ w2 :> FALSE)<br>observedPrepared = (w1 :> FALSE @@ w2 :> FALSE)<br>sends = 0<br>requeued = FALSE<br>effects = 0 |
| 2 | Unlock | phase = "bootstrapping"<br>generation = 1 |
| 3 | Bootstrap | phase = "ready" |
| 4 | Capture | requestGeneration = (w1 :> 1 @@ w2 :> 0)<br>pc = (w1 :> "captured" @@ w2 :> "idle")<br>kind = (w1 :> "read" @@ w2 :> "none") |
| 5 | DispatchRead | pc = (w1 :> "waiting" @@ w2 :> "idle") |
| 6 | Pause | phase = "paused"<br>generation = 2 |
| 7 | Return | pc = (w1 :> "response" @@ w2 :> "idle") |
| 8 | Deliver | requestGeneration = (w1 :> 0 @@ w2 :> 0)<br>badDelivery = TRUE<br>pc = (w1 :> "idle" @@ w2 :> "idle")<br>kind = (w1 :> "none" @@ w2 :> "none") |
