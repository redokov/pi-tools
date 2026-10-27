import time, sys

LOG = r"C:/Tools/pi-billing-window/.ai/sdd/specs/004-live-scenario-testing/sessions/A3-heartbeat.txt"

def write_line(line):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(line + "\n")
        f.flush()

def utc():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

write_line(f"STARTED {utc()}")
while True:
    time.sleep(40)
    write_line(f"beat {utc()}")
