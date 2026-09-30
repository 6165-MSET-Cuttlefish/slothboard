---
layout: default
---

# Features

## Telemetry

FTC apps keep the dashboard updated through periodic telemetry transmissions. Telemetry packets contain text key-value pairs like the provided SDK interfaces. They also store graphics to be displayed over the field image.

Packets have a map-like interface for adding unstructured data.

```java
TelemetryPacket packet = new TelemetryPacket();
packet.put("x", 3.7);
packet.put("status", "alive");
```

### Ordering

Telemetry is displayed in the order it was added, matching the Driver Station.

```java
packet.put("x", 3.7);
packet.addLine("--- drive ---");
packet.put("status", "alive");
```

```
x: 3.7
--- drive ---
status: alive
```

Unlike the SDK's `addData()`, `put()` overwrites a key already present, keeping its position.
`addLogEntry()` appends to the packet's log, shown below all items; entries added with
`telemetry.log().add(...)` persist across updates, nine at a time. The display is rebuilt from each
transmission, so telemetry that stops being sent stops being shown.

### Display format

Packets render a subset of HTML.

```java
packet.setDisplayFormat(TelemetryPacket.DisplayFormat.HTML); // the default
packet.put("status", "<font color='green'><b>alive</b></font>");
```

The `Telemetry` interface below defaults to `DisplayFormat.CLASSIC`, matching the Driver Station:
markup is displayed verbatim, so `<b>` and `a < b` both show up as written. The setting carries
over to later packets until the next op mode.

```java
telemetry.setDisplayFormat(Telemetry.DisplayFormat.HTML);
```

`DisplayFormat.MONOSPACE` keeps text verbatim in a monospace font. The format belongs to the packet
rather than the view, so each line renders in the format its sender chose; the Telemetry View's
menu overrides it for every line, and the override is not remembered across reloads.

Supported tags, as on the Driver Station: `b`, `strong`, `i`, `em`, `cite`, `dfn`, `u`, `s`,
`strike`, `del`, `sup`, `sub`, `big`, `small`, `tt`, `br`, `p`, `div`, `blockquote`, `ul`, `li`,
`h1`-`h6`, `font` (`color` and `face`), `span` and `a`, whose text is styled as a link but never
navigable. A `style` attribute is read on `p`, `span` and `li` (`color`, `background-color`,
`text-decoration: line-through`) and for `text-align` on any block element. Color names resolve to
the values Android uses, so `green` matches the Driver Station. Any other tag is dropped and its
text kept, except tags that can run code or load resources, such as `script`, `iframe` and `img`,
which are discarded with their content. Event handler attributes are always discarded.

The accessor `fieldOverlay()` returns a `Canvas` that records a sequence of drawing operations that show up in the Field View.

```java
packet.fieldOverlay()
    .setFill("blue")
    .fillRect(-20, -20, 40, 40);
```

Check out [this page](fieldview) for more information on Field View drawing.

Packets can also label their instant in time with `addMarker()`. Markers appear as labeled vertical lines in the Graph View, which makes it easy to line up events in the code with the data around them.

```java
if (intake.justStarted()) {
    packet.addMarker("intake on");
}
```

Markers can be placed from the client as well: click the plot to add a marker, type a label, and press Enter. Escape discards the marker instead, and clicking a marker removes it. Markers are anchored to a moment in telemetry time, so they scroll along with the data and disappear once they leave the graph window.

Use `FtcDashboard#sendTelemetryPacket()` to dispatch complete packets.

```java
FtcDashboard dashboard = FtcDashboard.getInstance();
dashboard.sendTelemetryPacket(packet);
```

For convenience, the dashboard offers an implementation of `Telemetry`.

```java
FtcDashboard dashboard = FtcDashboard.getInstance();
Telemetry dashboardTelemetry = dashboard.getTelemetry();

dashboardTelemetry.addData("x", 3.7);
dashboardTelemetry.update();
```

It follows the SDK's semantics: the `Item` returned by `addData()` stays addressable, `Func` values
are re-evaluated on every update, retained items survive a `clear()`, `setAutoClear(false)`
accumulates telemetry across updates, and `Double` and `Float` values are rounded when added, as
the Driver Station rounds them (`setNumDecimalPlaces()` adjusts this). Only `speak()` does nothing.

Each call to `update()` composes a packet from the telemetry currently set and sends it. Be careful: this indirection can mask the presence of multiple `sendTelemetryPacket()` calls in a single loop iteration.

A common idiom combines DS and dashboard telemetry together.

```java
public class MultipleTelemetryExampleOpMode extends OpMode {
    @Override
    public void init() {
        telemetry = new MultipleTelemetry(telemetry, FtcDashboard.getInstance().getTelemetry());

        // ...
    }

    // ...
}
```

## Configuration Variables

Configuration variables are special fields that the dashboard client can seamlessly modify while the app is running. To mark a field as a config variable, declare it `static` and not `final` and annotate the enclosing class with `@Config`.

```java
@Config
public class RobotConstants {
    public static int MAGIC_NUMBER = 32;
    public static PIDCoefficients TURNING_PID = new PIDCoefficients();
    // other constants
}
```

It's conventional to name variables in uppercase and treat them as constants inside the code. While saved dashboard changes instantly apply to the code fields, code-side changes only propagate to the client on explicit refresh.

Also, keep the copy semantics of Java primitives in mind when using this feature. Why does the following op mode fail to observe position offset changes during operation?

```java
public class ServoArm {
    private Servo servo;
    private double posOffset;

    public ServoArm(HardwareMap hardwareMap, double posOffset) {
        this.servo = hardwareMap.get(Servo.class, "servo");
        this.posOffset = posOffset;
    }

    public void setPosition(double pos) {
        servo.setPosition(posOffset + pos);
    }
}

@Config
public class StaleServoOpMode extends LinearOpMode {
    public static double SERVO_POS_OFFSET = 0.27;

    @Override
    public void runOpMode() {
        ServoArm arm = new ServoArm(hardwareMap, SERVO_POS_OFFSET);

        waitForStart();

        while (opModeIsActive()) {
            arm.setPosition(-gamepad1.left_stick_y);
        }
    }
}
```

The value of `SERVO_POS_OFFSET` is read once at the start of the op mode to pass to the `ServoArm` constructor. The field `posOffset` gets an independent copy of `SERVO_POS_OFFSET`; it only gets the new `SERVO_POS_OFFSET` when the op mode is reinitialized.

With some slight adjustments, position offset modifications can appear truly live,

```java
@Config
public class ServoArm {
    public static double POS_OFFSET = 0.27;

    private Servo servo;

    public ServoArm(HardwareMap hardwareMap) {
        this.servo = hardwareMap.get(Servo.class, "servo");
    }

    public void setPosition(double pos) {
        servo.setPosition(POS_OFFSET + pos);
    }
}

public class FixedServoOpMode extends LinearOpMode {
    @Override
    public void runOpMode() {
        ServoArm arm = new ServoArm(hardwareMap);

        waitForStart();

        while (opModeIsActive()) {
            arm.setPosition(-gamepad1.left_stick_y);
        }
    }
}
```

Java experts may have noticed that `POS_OFFSET` can still be stale or partially updated. If this bothers you, mark all your config variable fields with `volatile`. You can read more about word tearing in [JLS 17.7](https://docs.oracle.com/javase/specs/jls/se8/html/jls-17.html#jls-17.7).

Config variable declarations in Kotlin are cumbersome but still possible with `@JvmField`.

```kotlin
@Config
object RobotConstants {
    @JvmField var MAGIC_NUMBER = 32
    @JvmField var TURNING_PID = PIDCoefficients()
    // other constants
}
```

## Custom Layouts

The "Custom" layout preset lets you arrange any set of views on a grid. Press the pencil button in the bottom right to unlock the layout, then use the buttons around it to add views, delete views, clear the layout, or share it.

To share a custom layout, choose "Share or Save Layout" and copy the code or link. Another dashboard user can paste either one into the "Import a layout" box, or open the link directly. A link only works when the other user's dashboard has the same address (for example, both on Control Hubs at `192.168.43.1:8080/dash`), so send the code when in doubt.

A code carries only the position and size of each view, not settings inside a view such as graph colors. Sizes are fixed grid rows, so a layout made on a tall screen may run below the fold on a shorter one.

To keep more than one custom layout, open "Share or Save Layout", give the layout a name and press Save. Saving under a name that is already taken replaces that entry. Saved layouts appear in the layout list at the top of the page. Picking one loads it, and the list marks it as edited once you change it. Picking it again after visiting another preset brings back your edits, while Load in the dialog discards them. Picking "Custom" detaches from it. Load and Delete for each saved layout are in the same dialog. They are stored in this browser only.

Layout codes are plain text and can be edited by hand. Each entry is `<view>:<x>,<y>,<width>,<height>` on a 12-column grid.

```
v1;field:0,0,4,9;graph:4,0,4,9;config:8,0,4,7;telemetry:8,7,4,2
```

## Op Mode Controls

Op mode controls replicate limited DS functionality. Some gamepads are supported for testing in a pinch. Plug them in and press Start-A/B as usual to activate. Dashboard gamepads will have higher latency and less robustness than DS ones and should be used accordingly. Safety mechanisms attempt to stop the robot if gamepads spontaneously disconnect, but there are no guarantees.

## Camera

Teams may be interested in previewing the two different vision systems, vision portal and traditional EasyOpenCV. The vision portal API was introduced in CenterStage 2023-2024 and it's usage with FTC dashboard is documented [in this op mode](https://github.com/acmerobotics/ftc-dashboard/blob/master/TeamCode/src/main/java/org/firstinspires/ftc/teamcode/VisionPortalStreamingOpMode.java).

It is also possible to use traditional EasyOpenCV, using a call like `FtcDashboard.getInstance().startCameraStream(camera, 0);` where `camera` implements `CameraStreamSource`. In EasyOpenCV, this camera will be the same one you initialize with the code below.

```java
int cameraMonitorViewId = hardwareMap.appContext.getResources().getIdentifier("cameraMonitorViewId", "id", hardwareMap.appContext.getPackageName());
OpenCvWebcam camera = OpenCvCameraFactory.getInstance().createWebcam(hardwareMap.get(WebcamName.class, "Webcam 1"), cameraMonitorViewId);
FtcDashboard.getInstance().startCameraStream(camera, 0);
```

## Loop Time View

The Loop Time view charts where an op mode's loop spends its time. It reads plain numeric telemetry, so any timing you already report works, and [`LoopTimer`](https://github.com/acmerobotics/ftc-dashboard/blob/master/DashboardCore/src/main/java/com/acmerobotics/dashboard/telemetry/LoopTimer.java) does the bookkeeping for you.

```java
private final LoopTimer timer = new LoopTimer();
private long lastReport;

@Override
public void loop() {
    timer.startLoop();
    timer.beginSegment("sensors");
    readSensors();
    timer.beginSegment("vision");
    processVision();
    timer.endLoop();

    // Loops run far faster than telemetry is sent, so report on a timer.
    long now = System.currentTimeMillis();
    if (now - lastReport >= 50) {
        TelemetryPacket packet = new TelemetryPacket(false);
        timer.addTo(packet);
        FtcDashboard.getInstance().sendTelemetryPacket(packet);
        lastReport = now;
    }
}
```

`addTo` writes one key per segment (`loop/sensors`, `loop/vision`, ...) plus `loop/total` and `loop/worst`, all in milliseconds. Each value is the mean over every loop since the last `addTo`, while `loop/worst` is the longest single loop in that span; `total` and `worst` are reserved segment names. A segment can also be scoped with `try (LoopTimer.Segment s = timer.segment("vision"))`. [`LoopTimeDemoOpMode`](https://github.com/acmerobotics/ftc-dashboard/blob/master/TeamCode/src/main/java/org/firstinspires/ftc/teamcode/LoopTimeDemoOpMode.java) runs this against a synthetic loop.

In the dashboard, add a Loop Time view and open its gear icon:

- **Auto-add matching** makes a segment of every unused key containing the filter text, claiming a `.../total` key as the loop total and a `.../worst` key as the worst loop.
- **Budget (ms)** draws a target line on the history chart and turns the loop readout red above it.
- Setups are saved as named **profiles** in this browser; **Share** shows the active one as JSON so you can move it to another machine.

## Color View

The Color view compares what an I2C color sensor reads against a color you
expect, with no robot code of its own: run the **Hardware** op mode with a
color sensor in your configuration. A picker appears when more than one sensor
is published.

Enter the expected color as a hex code, `rgb(r, g, b)`, a bare `r, g, b` triple,
or one of the built-in presets. The tolerance beside it is the largest
[CIEDE2000](https://en.wikipedia.org/wiki/Color_difference#CIEDE2000)
difference (ΔE) counted as a match: under 1 is imperceptible, over 10 is
clearly different.

The gear icon picks how the raw counts map into 0-255:

- **Auto** scales to the brightest channel. Ignoring brightness is the
  steadiest way to tell game elements apart, so this is the default, but white,
  grey and black all normalize to the same color.
- **8-bit** takes the raw counts as 0-255.
- **Alpha** divides them by the sensor's alpha reading. Like Auto, it cannot
  tell white, grey and black apart.
- **Manual** divides them by a value you choose.

The expected color, tolerance, sensor, mode and Manual divisor are saved in the
browser.
