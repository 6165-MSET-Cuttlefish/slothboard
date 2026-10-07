package com.acmerobotics.dashboard;

import com.qualcomm.robotcore.eventloop.opmode.OpMode;
import com.qualcomm.robotcore.hardware.Gamepad;
import com.qualcomm.robotcore.util.RobotLog;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;

/**
 * Hands gamepad state to an op mode the way the SDK hands it a Driver Station packet. An iterative
 * op mode copies the latest packet over gamepad1 and gamepad2 before every loop, so state written
 * straight into those fields only ever reaches a LinearOpMode.
 */
final class OpModeGamepads {
    private static final String TAG = "OpModeGamepads";

    private static final Method NEW_GAMEPAD_DATA_AVAILABLE = findNewGamepadDataAvailable();

    private OpModeGamepads() {}

    /** The dashboard only drives gamepads that no Driver Station gamepad is assigned to. */
    static boolean unassociated(OpMode opMode) {
        return opMode.gamepad1.getGamepadId() == Gamepad.ID_UNASSOCIATED
                && opMode.gamepad2.getGamepadId() == Gamepad.ID_UNASSOCIATED;
    }

    static void rest(OpMode opMode) {
        if (unassociated(opMode)) {
            deliver(opMode, new Gamepad(), new Gamepad());
        }
    }

    /** The op mode must not see later changes to either gamepad, so pass fresh ones. */
    static void deliver(OpMode opMode, Gamepad gamepad1, Gamepad gamepad2) {
        if (NEW_GAMEPAD_DATA_AVAILABLE == null) {
            opMode.gamepad1.copy(gamepad1);
            opMode.gamepad2.copy(gamepad2);
            return;
        }

        try {
            NEW_GAMEPAD_DATA_AVAILABLE.invoke(opMode, gamepad1, gamepad2);
        } catch (IllegalAccessException e) {
            throw new IllegalStateException(e);
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            if (cause instanceof RuntimeException) {
                throw (RuntimeException) cause;
            }
            if (cause instanceof Error) {
                throw (Error) cause;
            }
            throw new IllegalStateException(cause);
        }
    }

    private static Method findNewGamepadDataAvailable() {
        try {
            Method method =
                    OpMode.class.getDeclaredMethod(
                            "newGamepadDataAvailable", Gamepad.class, Gamepad.class);
            method.setAccessible(true);
            return method;
        } catch (NoSuchMethodException | SecurityException e) {
            RobotLog.ww(
                    TAG,
                    "OpMode.newGamepadDataAvailable not found; writing dashboard gamepads into"
                            + " gamepad1/gamepad2 directly, which iterative op modes overwrite");
            return null;
        }
    }
}
