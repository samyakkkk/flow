import * as NodeTest from "node:test";
const { test } = NodeTest;
import * as NodeAssert from "node:assert/strict";
const assert = NodeAssert;
import { renderLaunchdPlist, renderSystemdUnit } from "./service-unit.mjs";

const plan = {
  label: "com.flow.service",
  nodePath: "/opt/flow/runtime/bin/node",
  args: ["/opt/flow/current/scripts/flow.mjs", "--supervise", "/data/instances/primary"],
  env: {
    PATH: "/opt/flow/runtime/bin:/usr/bin",
    FLOW_INSTANCE_HOME: "/data",
    FLOW_SERVICE_MANAGED: "1",
  },
  logPath: "/data/instances/primary/runtime.log",
  workingDirectory: "/home/dev",
};

test("the launch agent restarts only failures and runs the supervisor directly", () => {
  const plist = renderLaunchdPlist(plan);
  assert.match(
    plist,
    /<key>KeepAlive<\/key>\n {2}<dict>\n {4}<key>SuccessfulExit<\/key>\n {4}<false\/>/,
  );
  assert.match(plist, /<key>ThrottleInterval<\/key>\n {2}<integer>5<\/integer>/);
  assert.match(plist, /<key>ExitTimeOut<\/key>\n {2}<integer>90<\/integer>/);
  assert.match(plist, /<key>ProcessType<\/key>\n {2}<string>Interactive<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\n {2}<true\/>/);
  for (const value of [plan.nodePath, ...plan.args])
    assert.ok(plist.includes(`    <string>${value}</string>`), value);
  assert.ok(plist.includes("--supervise"));
  assert.ok(!plist.includes("T3CODE_HOME"));
  for (const [key, value] of Object.entries(plan.env))
    assert.ok(plist.includes(`    <key>${key}</key>\n    <string>${value}</string>`), key);
  assert.equal(plist.split("StandardOutPath").length, 2);
  assert.ok(plist.endsWith("</plist>\n"));
});

test("plist text nodes escape XML so an unusual path cannot break the document", () => {
  const plist = renderLaunchdPlist({
    ...plan,
    workingDirectory: "/home/a&b",
    args: ["/opt/<flow>/scripts/flow.mjs"],
    env: { PATH: "/a>b" },
  });
  assert.ok(plist.includes("<string>/home/a&amp;b</string>"));
  assert.ok(plist.includes("<string>/opt/&lt;flow&gt;/scripts/flow.mjs</string>"));
  assert.ok(plist.includes("<string>/a&gt;b</string>"));
  assert.ok(!/<string>[^<]*[&][^a-z#]/.test(plist));
});

test("the systemd unit restarts on failure and survives an OOM-killed agent child", () => {
  const unit = renderSystemdUnit(plan);
  assert.match(unit, /^Type=simple$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^RestartSec=5$/m);
  assert.match(unit, /^KillMode=mixed$/m);
  assert.match(unit, /^OOMPolicy=continue$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
  assert.match(
    unit,
    /^ExecStart=\/opt\/flow\/runtime\/bin\/node \/opt\/flow\/current\/scripts\/flow\.mjs --supervise \/data\/instances\/primary$/m,
  );
  assert.match(unit, /^StandardOutput=append:\/data\/instances\/primary\/runtime\.log$/m);
  assert.match(unit, /^StandardError=append:\/data\/instances\/primary\/runtime\.log$/m);
  for (const [key, value] of Object.entries(plan.env))
    assert.match(unit, new RegExp(`^Environment=${key}=${value.replaceAll("/", "\\/")}$`, "m"));
  assert.ok(!unit.includes("T3CODE_HOME"));
});

test("systemd values quote whitespace and escape its percent specifiers", () => {
  const unit = renderSystemdUnit({
    ...plan,
    logPath: "/var/log/100% full/flow.log",
    workingDirectory: "/home/my dev",
    env: { PATH: "/a b" },
  });
  assert.match(unit, /^WorkingDirectory="\/home\/my dev"$/m);
  assert.match(unit, /^Environment=PATH="\/a b"$/m);
  assert.match(unit, /^StandardOutput=append:\/var\/log\/100%% full\/flow\.log$/m);
});
