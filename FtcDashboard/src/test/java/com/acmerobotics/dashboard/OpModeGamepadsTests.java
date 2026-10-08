package com.acmerobotics.dashboard;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.qualcomm.robotcore.eventloop.opmode.LinearOpMode;
import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.hardware.Gamepad;
import java.lang.reflect.Method;
import org.junit.jupiter.api.Test;

public class OpModeGamepadsTests {
    static final class Iterative extends OpMode {
        @Override
        public void init() {}

        @Override
        public void loop() {}
    }

    static final class Linear extends LinearOpMode {
        @Override
        public void runOpMode() {}
    }

    private static <T extends OpMode> T withGamepads(T opMode) {
        opMode.gamepad1 = new Gamepad();
        opMode.gamepad2 = new Gamepad();
        return opMode;
    }

    private static void beforeLoop(OpMode opMode) throws Exception {
        Method preUserCode = OpMode.class.getDeclaredMethod("internalPreUserCode");
        preUserCode.setAccessible(true);
        preUserCode.invoke(opMode);
    }

    private static Gamepad pressing(float leftStickY, boolean a) {
        Gamepad gamepad = new Gamepad();
        gamepad.left_stick_y = leftStickY;
        gamepad.a = a;
        return gamepad;
    }

    @Test
    public void writingGamepad1DirectlyIsLostInAnIterativeOpMode() throws Exception {
        Iterative opMode = withGamepads(new Iterative());
        opMode.gamepad1.copy(pressing(-0.5f, true));

        beforeLoop(opMode);

        assertEquals(0f, opMode.gamepad1.left_stick_y);
    }

    @Test
    public void iterativeOpModeSeesDeliveredStateEveryLoop() throws Exception {
        Iterative opMode = withGamepads(new Iterative());
        OpModeGamepads.deliver(opMode, pressing(-0.5f, true), pressing(0.25f, false));

        beforeLoop(opMode);
        assertEquals(-0.5f, opMode.gamepad1.left_stick_y);
        assertEquals(0.25f, opMode.gamepad2.left_stick_y);
        assertTrue(opMode.gamepad1.aWasPressed());

        beforeLoop(opMode);
        assertEquals(-0.5f, opMode.gamepad1.left_stick_y);
        assertTrue(opMode.gamepad1.a);
        assertFalse(opMode.gamepad1.aWasPressed());
    }

    @Test
    public void restingStopsAnIterativeOpMode() throws Exception {
        Iterative opMode = withGamepads(new Iterative());
        OpModeGamepads.deliver(opMode, pressing(-0.5f, true), new Gamepad());
        beforeLoop(opMode);
        assertEquals(-0.5f, opMode.gamepad1.left_stick_y);
        assertTrue(opMode.gamepad1.a);

        OpModeGamepads.rest(opMode);
        beforeLoop(opMode);

        assertEquals(0f, opMode.gamepad1.left_stick_y);
        assertFalse(opMode.gamepad1.a);
        assertTrue(opMode.gamepad1.aWasReleased());
    }

    @Test
    public void restingLeavesADriverStationGamepadAlone() throws Exception {
        Iterative opMode = withGamepads(new Iterative());
        Gamepad driverStation = pressing(-0.5f, false);
        driverStation.setGamepadId(3);
        OpModeGamepads.deliver(opMode, driverStation, new Gamepad());
        beforeLoop(opMode);

        OpModeGamepads.rest(opMode);
        beforeLoop(opMode);

        assertEquals(-0.5f, opMode.gamepad1.left_stick_y);
    }

    @Test
    public void linearOpModeSeesDeliveredStateImmediately() {
        Linear opMode = withGamepads(new Linear());

        OpModeGamepads.deliver(opMode, pressing(0.75f, true), new Gamepad());

        assertEquals(0.75f, opMode.gamepad1.left_stick_y);
        assertTrue(opMode.gamepad1.aWasPressed());
    }
}
