# Program runs of the 0.7.1 arms before the reasoning fix

Real runs of the Program task on the 0.7.1 sources before commit `5d58c46`. Every one of them is BLOCKED at
the verification of the first milestone: the milestone verifier answered with a report in prose instead of
the JSON object the engine reads. The 0.7.0 runs in `../campaign` fail the same way (one fails earlier, at
the program plan): the prompts and the parser were those of 0.7.0, so this was not a 0.7.1 change.

`a8a2e24` (the retry says what was wrong) did not help: the two runs made on it are here too.
`5d58c46` (the runtime enforces the shape of the answer) did: the runs in `../campaign` are made on it.

These files are kept as the evidence of the defect. They are not part of the campaign's tables.
