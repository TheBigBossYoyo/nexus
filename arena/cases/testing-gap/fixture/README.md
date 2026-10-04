# cronkit

Parse five-field cron expressions and compute upcoming run times. Everything is evaluated in UTC.

```js
import { parseCron, nextRun, upcoming, matches } from './src/index.js'

const schedule = parseCron('*/15 9-17 * * MON-FRI')
nextRun(schedule, new Date('2024-03-01T17:50:00Z')) // Monday 2024-03-04T09:00:00Z
```

## Syntax

`minute hour day-of-month month day-of-week`, or one of `@yearly`, `@annually`, `@monthly`, `@weekly`,
`@daily`, `@midnight`, `@hourly`.

Each field accepts `*`, `n`, `a-b`, `*/step`, `a-b/step`, `a/step` (a through the maximum) and comma lists.
Month (`JAN`..`DEC`) and weekday (`SUN`..`SAT`) names are case-insensitive. Day-of-week 7 means Sunday.
When both day-of-month and day-of-week are restricted, a day matches if either does (classic cron);
if one of them starts with `*`, the other decides alone.

Invalid input throws `CronError`. `nextRun` returns `null` when nothing is scheduled within five years.

Run the tests with `npm test`.
