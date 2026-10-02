import { Expo, type ExpoPushMessage } from "expo-server-sdk";
import User from "../utils/models/User.js";
import PushReceipt from "../utils/models/PushReceipt.js";

const expoAccessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
const expo = new Expo(expoAccessToken ? { accessToken: expoAccessToken } : {});
const receiptDelayMs = 15 * 60 * 1000;
const receiptRetryMs = 15 * 60 * 1000;
const receiptWorkerIntervalMs = 15 * 60 * 1000;

interface ChatPushInput {
  recipientUserIds: string[];
  conversationId: string;
  conversationType: "direct" | "group";
  conversationName?: string | undefined;
  senderId: string;
  senderName: string;
  messageId: string;
  hasText: boolean;
  attachment: boolean;
}

export async function sendChatMessagePush({
  recipientUserIds,
  conversationId,
  conversationType,
  conversationName,
  senderId,
  senderName,
  messageId,
  hasText,
  attachment,
}: ChatPushInput): Promise<void> {
  try {
    if (recipientUserIds.length === 0) return;

    const users = await User.find({ _id: { $in: recipientUserIds } })
      .select("pushTokens")
      .lean();
    const recipientTokens = [
      ...new Set(users.flatMap((user) => user.pushTokens ?? [])),
    ];
    const invalidFormatTokens = recipientTokens.filter(
      (token) => !Expo.isExpoPushToken(token)
    );
    const validTokens = recipientTokens.filter((token) =>
      Expo.isExpoPushToken(token)
    );

    if (invalidFormatTokens.length > 0) {
      await User.updateMany(
        { pushTokens: { $in: invalidFormatTokens } },
        { $pull: { pushTokens: { $in: invalidFormatTokens } } }
      );
      console.warn(`Removed ${invalidFormatTokens.length} malformed Expo push token(s).`);
    }

    const body = attachment
      ? "Sent you an attachment"
      : hasText
        ? "Sent you a message"
        : "Sent you a message";
    const messages: ExpoPushMessage[] = validTokens.map((to) => ({
      to,
      title: senderName || "New message",
      body,
      sound: "default",
      priority: "high",
      channelId: "messages",
      data: {
        type: "chat_message",
        conversationId,
        conversationType,
        conversationName:
          conversationType === "group"
            ? conversationName || "Group chat"
            : senderName || "Chat",
        senderId,
        senderName: senderName || "New message",
        messageId,
      },
    }));

    for (const chunk of expo.chunkPushNotifications(messages)) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        const receiptRecords: Array<{
          ticketId: string;
          pushToken: string;
        }> = [];

        for (const [index, ticket] of tickets.entries()) {
          const pushToken = chunk[index]?.to;
          if (ticket.status === "ok" && typeof pushToken === "string") {
            receiptRecords.push({ ticketId: ticket.id, pushToken });
            continue;
          }

          if (ticket.status === "error") {
            console.error("Expo push ticket failed:", ticket.message);
            if (
              ticket.details?.error === "DeviceNotRegistered" &&
              typeof pushToken === "string"
            ) {
              await removeInvalidToken(pushToken);
            }
          }
        }

        if (receiptRecords.length > 0) {
          const now = new Date();
          await PushReceipt.insertMany(
            receiptRecords.map((record) => ({
              ...record,
              createdAt: now,
              updatedAt: now,
            })),
            { ordered: false }
          );
        }
      } catch (error) {
        console.error("Failed to send an Expo push notification chunk:", error);
      }
    }
  } catch (error) {
    console.error("Failed to prepare chat push notifications:", error);
  }
}

async function removeInvalidToken(pushToken: string): Promise<void> {
  await User.updateMany(
    { pushTokens: pushToken },
    { $pull: { pushTokens: pushToken } }
  );
  console.warn("Removed an unregistered Expo push token.");
}

let receiptWorkerStarted = false;
let receiptWorkerRunning = false;

export function startPushReceiptWorker(): void {
  if (receiptWorkerStarted) return;
  receiptWorkerStarted = true;

  const processReceipts = () => {
    void processPendingReceipts();
  };
  processReceipts();
  const interval = setInterval(processReceipts, receiptWorkerIntervalMs);
  interval.unref();
}

async function processPendingReceipts(): Promise<void> {
  if (receiptWorkerRunning) return;
  receiptWorkerRunning = true;

  try {
    const now = Date.now();
    const dueBefore = new Date(now - receiptDelayMs);
    const retryBefore = new Date(now - receiptRetryMs);
    const pendingReceipts = await PushReceipt.find({
      createdAt: { $lte: dueBefore },
      $or: [
        { lastCheckedAt: { $exists: false } },
        { lastCheckedAt: { $lte: retryBefore } },
      ],
    })
      .sort({ createdAt: 1 })
      .limit(1000)
      .lean();

    if (pendingReceipts.length === 0) return;

    const ticketIds = pendingReceipts.map((record) => record.ticketId);
    const receiptIds = expo.chunkPushNotificationReceiptIds(ticketIds);
    for (const receiptIdChunk of receiptIds) {
      try {
        const receipts = await expo.getPushNotificationReceiptsAsync(
          receiptIdChunk
        );

        for (const [ticketId, receipt] of Object.entries(receipts)) {
          const record = pendingReceipts.find(
            (candidate) => candidate.ticketId === ticketId
          );
          if (!record) continue;

          if (receipt.status === "error") {
            console.error("Expo push receipt failed:", receipt.message);
            if (receipt.details?.error === "DeviceNotRegistered") {
              await removeInvalidToken(record.pushToken);
            }
          }

          await PushReceipt.deleteOne({ ticketId });
        }
      } catch (error) {
        console.error("Failed to check Expo push receipts:", error);
      }
    }

    await PushReceipt.updateMany(
      { ticketId: { $in: ticketIds } },
      { $set: { lastCheckedAt: new Date() } }
    );
  } catch (error) {
    console.error("Failed to process pending Expo push receipts:", error);
  } finally {
    receiptWorkerRunning = false;
  }
}