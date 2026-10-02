import type { Response } from "express";
import User from "../utils/models/User.js";
import type { AuthenticatedRequest } from "../middleware/auth.middleware.js";

/*
 * ---------------------------------------------------------
 * SAVE PUSH TOKEN
 * ---------------------------------------------------------
 *
 * This endpoint receives an Expo Push Token from the
 * user's phone and saves it to that user's MongoDB record.
 *
 * The user is identified by the JWT.
 *
 * The client does NOT send a userId.
 *
 * This is important for security.
 */
export const savePushToken = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  try {
    /*
     * Get the authenticated user's ID from the middleware.
     */
    const userId = req.userId;

    if (!userId) {
      res.status(401).json({
        success: false,
        msg: "Authentication required",
      });

      return;
    }

    /*
     * Get the Expo Push Token from the request body.
     */
    const { pushToken } = req.body;

    /*
     * Validate the token.
     */
    if (
      !pushToken ||
      typeof pushToken !== "string"
    ) {
      res.status(400).json({
        success: false,
        msg: "Push token is required",
      });

      return;
    }

    /*
     * Add the token only if it isn't already stored.
     *
     * $addToSet prevents duplicate tokens.
     */
    // A device token belongs to the account currently using this device.
    await User.updateMany(
      { _id: { $ne: userId }, pushTokens: pushToken },
      { $pull: { pushTokens: pushToken } }
    );

    const user = await User.findByIdAndUpdate(
      userId,
      {
        $addToSet: {
          pushTokens: pushToken,
        },
      },
      {
        new: true,
      }
    );

    /*
     * User doesn't exist anymore.
     */
    if (!user) {
      res.status(404).json({
        success: false,
        msg: "User not found",
      });

      return;
    }

    console.log(
      `Push token saved for user: ${userId}`
    );

    res.json({
      success: true,
      msg: "Push token saved successfully",
    });
  } catch (error) {
    console.log(
      "Failed to save push token:",
      error
    );

    res.status(500).json({
      success: false,
      msg: "Server Error",
    });
  }
};

export const removePushToken = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const userId = req.userId;
  const { pushToken } = req.body;

  if (!userId) {
    res.status(401).json({ success: false, msg: "Authentication required" });
    return;
  }

  if (typeof pushToken !== "string" || !pushToken.trim()) {
    res.status(400).json({ success: false, msg: "Push token is required" });
    return;
  }

  try {
    await User.updateOne({ _id: userId }, { $pull: { pushTokens: pushToken } });
    res.json({ success: true, msg: "Push token removed successfully" });
  } catch (error) {
    console.error("Failed to remove push token:", error);
    res.status(500).json({ success: false, msg: "Server Error" });
  }
};