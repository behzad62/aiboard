process.stdout.write("persistent-child-ready\n");
setInterval(() => process.stdout.write("persistent-child-alive\n"), 250);
