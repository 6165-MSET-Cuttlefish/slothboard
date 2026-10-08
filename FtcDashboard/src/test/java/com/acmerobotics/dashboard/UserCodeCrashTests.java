package com.acmerobotics.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.acmerobotics.dashboard.message.redux.ReceiveLogcatErrors;
import org.junit.jupiter.api.Test;

public class UserCodeCrashTests {
    private static ReceiveLogcatErrors.LogcatError line(
            long timestamp, String tag, String message) {
        return new ReceiveLogcatErrors.LogcatError(timestamp, "ERROR", tag, message);
    }

    private static void crash(UserCodeCrash crash, long timestamp, String tag, String exception) {
        crash.accept(line(timestamp, tag, UserCodeCrash.MESSAGE));
        crash.accept(line(timestamp, tag, exception));
        crash.accept(
                line(timestamp, tag, "at org.firstinspires.ftc.teamcode.Auto.loop(Auto.java:42)"));
    }

    @Test
    public void reportsTheExceptionThatFollowsTheCrashLine() {
        UserCodeCrash crash = new UserCodeCrash(1000);

        crash(crash, 2000, "OpModeManager", "java.lang.IllegalStateException: no heading");

        assertEquals(
                "OpModeManager: User code threw an uncaught exception:"
                        + " java.lang.IllegalStateException: no heading",
                crash.getMessage());
    }

    @Test
    public void reportsACameraThreadCrash() {
        UserCodeCrash crash = new UserCodeCrash(1000);

        crash(crash, 2000, "OpenCvCamera", "java.lang.ArithmeticException: / by zero");

        assertEquals(
                "OpenCvCamera: User code threw an uncaught exception:"
                        + " java.lang.ArithmeticException: / by zero",
                crash.getMessage());
    }

    @Test
    public void showsTheCrashBeforeItsExceptionLineArrives() {
        UserCodeCrash crash = new UserCodeCrash(1000);

        crash.accept(line(2000, "OpModeManager", UserCodeCrash.MESSAGE));

        assertEquals("OpModeManager: User code threw an uncaught exception", crash.getMessage());
    }

    @Test
    public void readsACrashLineCarryingTheDriverStationClock() {
        UserCodeCrash crash = new UserCodeCrash(1000);

        crash.accept(line(2000, "OpModeManager", "{  123  4.567} " + UserCodeCrash.MESSAGE));
        crash.accept(line(2000, "OpModeManager", "java.lang.RuntimeException: boom"));

        assertEquals(
                "OpModeManager: User code threw an uncaught exception:"
                        + " java.lang.RuntimeException: boom",
                crash.getMessage());
    }

    @Test
    public void ignoresCrashesFromBeforeTheLastInit() {
        UserCodeCrash crash = new UserCodeCrash(1000);

        crash(crash, 999, "OpModeManager", "java.lang.RuntimeException: last session");

        assertEquals("", crash.getMessage());
    }

    @Test
    public void ignoresOtherLinesWhenNoCrashIsPending() {
        UserCodeCrash crash = new UserCodeCrash(1000);

        crash.accept(line(2000, "OpModeManager", "java.lang.RuntimeException: not a crash"));

        assertEquals("", crash.getMessage());
    }

    @Test
    public void resetClearsTheCrashAndIgnoresOlderLines() {
        UserCodeCrash crash = new UserCodeCrash(1000);
        crash(crash, 2000, "OpModeManager", "java.lang.RuntimeException: first");

        crash.reset(3000);
        crash(crash, 2500, "OpModeManager", "java.lang.RuntimeException: delivered late");

        assertEquals("", crash.getMessage());
    }

    @Test
    public void keepsTheMostRecentCrash() {
        UserCodeCrash crash = new UserCodeCrash(1000);

        crash(crash, 2000, "OpenCvCamera", "java.lang.RuntimeException: first");
        crash(crash, 2100, "OpModeManager", "java.lang.RuntimeException: second");

        assertEquals(
                "OpModeManager: User code threw an uncaught exception:"
                        + " java.lang.RuntimeException: second",
                crash.getMessage());
    }
}
