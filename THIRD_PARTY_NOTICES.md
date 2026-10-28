# Third-party notices

## WorkoutVision

This project adapts selected video-decoding and reference-curve utilities from
[david-dabert/workout-vision](https://github.com/david-dabert/workout-vision),
commit `e4948c2f78e897f0adf7c2cae296d08c8975939b` (28 October 2026).
Original files and their MIT license are kept in `src/vendor/workoutvision/`.
The Chinese interface and bench-specific analysis are developed for Fitness Pro.
No upstream form scores, clinical tolerances, or accuracy claims are inherited.

## MediaPipe

`@mediapipe/tasks-vision` is distributed under Apache-2.0. The pose model is
downloaded from Google's official MediaPipe model distribution at build time.
Its provenance and hash are recorded in the build log. Files are served from the
same site; videos and landmarks are not sent to a model API.

## Other dependencies

React / React DOM: MIT. Vite: MIT. web-demuxer: MIT. Dependency packages retain
their own licenses. The repository's LICENSE applies to original Fitness Pro code.
