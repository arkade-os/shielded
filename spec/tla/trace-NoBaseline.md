VIOLATED NoMissedEvent, 7 states

| # | action | changed |
|---|---|---|
| 1 | Initial | state = (s1 :> "live" @@ s2 :> "live")<br>faults = 0<br>missed = (s1 :> FALSE @@ s2 :> FALSE)<br>attempts = (s1 :> 0 @@ s2 :> 0)<br>torn = 0<br>baseline = (s1 :> TRUE @@ s2 :> TRUE)<br>events = 0<br>escalated = FALSE<br>lost = (s1 :> FALSE @@ s2 :> FALSE) |
| 2 | LoseBaseline | faults = 1<br>baseline = (s1 :> FALSE @@ s2 :> TRUE) |
| 3 | Fail | state = (s1 :> "broken" @@ s2 :> "live")<br>faults = 2 |
| 4 | Backoff | state = (s1 :> "backoff" @@ s2 :> "live")<br>attempts = (s1 :> 1 @@ s2 :> 0) |
| 5 | Event | missed = (s1 :> TRUE @@ s2 :> FALSE)<br>events = 1<br>lost = (s1 :> TRUE @@ s2 :> FALSE) |
| 6 | Reopen | state = (s1 :> "reopened" @@ s2 :> "live") |
| 7 | CatchUpRead | state = (s1 :> "live" @@ s2 :> "live")<br>missed = (s1 :> FALSE @@ s2 :> FALSE)<br>baseline = (s1 :> TRUE @@ s2 :> TRUE) |
