// Strong Suit server: everything players must not be able to fake.
// Answers are checked here, so the answer key never reaches a phone before a round is submitted.
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { makeHandlers } from "./lib/handlers.js";

setGlobalOptions({ region: "europe-west2", maxInstances: 20, memory: "256MiB", timeoutSeconds: 30 });
initializeApp();
const h = makeHandlers({ db: getFirestore(), FieldValue, Timestamp, auth: getAuth(), HttpsError });
const call = fn => onCall({ cors: true }, async req => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  return fn(req.data || {}, req.auth.uid);
});
export const startHand = call(h.startHand);
export const startRound = call(h.startRound);
export const submitRound = call(h.submitRound);
export const setName = call(h.setName);
export const getMe = call(h.getMe);
export const createGroup = call(h.createGroup);
export const joinGroup = call(h.joinGroup);
export const leaveGroup = call(h.leaveGroup);
export const deleteAccount = call(h.deleteAccount);
