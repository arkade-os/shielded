VIOLATED NoMissedEvent, 6 states

| # | action | changed |
|---|---|---|
| 1 | Initial | state = (s1 :> "live" @@ s2 :> "live")<br>faults = 0<br>missed = (s1 :> FALSE @@ s2 :> FALSE)<br>attempts = (s1 :> 0 @@ s2 :> 0)<br>torn = 0<br>baseline = (s1 :> TRUE @@ s2 :> TRUE)<br>events = 0<br>escalated = FALSE<br>lost = (s1 :> FALSE @@ s2 :> FALSE) |
| 2 | Fail | state = (s1 :> "broken" @@ s2 :> "live")<br>faults = 1 |
| 3 | Backoff | state = (s1 :> "backoff" @@ s2 :> "live")<br>attempts = (s1 :> 1 @@ s2 :> 0) |
| 4 | CatchUpRead | state = (s1 :> "read" @@ s2 :> "live") |
| 5 | Event | missed = (s1 :> TRUE @@ s2 :> FALSE)<br>events = 1<br>lost = (s1 :> TRUE @@ s2 :> FALSE) |
| 6 | Reopen | state = (s1 :> "live" @@ s2 :> "live") |
