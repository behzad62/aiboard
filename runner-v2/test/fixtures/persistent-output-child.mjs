const frames = Array.from({ length: 12 }, (_, index) =>
  `frame-${String(index).padStart(2, "0")}:${"x".repeat(48)}\n`
);
let next = 0;
const output = setInterval(() => {
  process.stdout.write(frames[next]);
  next += 1;
  if (next === frames.length) clearInterval(output);
}, 50);

// The protocol process remains alive after producing its bounded fixture
// output so the test exercises multiple separately authorized calls.
setInterval(() => undefined, 1_000);
