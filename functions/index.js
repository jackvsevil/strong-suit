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
  if (req.data && req.data.warm === true) return { warm: true };   // a wake-up call from the app, so the next real request skips the cold start
  return fn(req.data || {}, req.auth.uid, req.auth.token);   // the token says whether they're a guest
});
export const startHand = call(h.startHand);
export const startRound = call(h.startRound);
export const submitRound = call(h.submitRound);
export const setName = call(h.setName);
export const getMe = call(h.getMe);
export const claimScores = call(h.claimScores);
export const createGroup = call(h.createGroup);
export const joinGroup = call(h.joinGroup);
export const leaveGroup = call(h.leaveGroup);
export const updateGroup = call(h.updateGroup);
export const removeMember = call(h.removeMember);
export const newGroupCode = call(h.newGroupCode);
export const groupDay = call(h.groupDay);
export const groupMonth = call(h.groupMonth);
export const groupPreview = call(h.groupPreview);
// Admin page: only Google-verified addresses listed in ADMIN_EMAILS (the GitHub secret, written to functions/.env at deploy; empty means nobody).
const ADMINS = (process.env.ADMIN_EMAILS || "").toLowerCase().split(",").map(x => x.trim()).filter(Boolean);
export const adminStats = onCall({ cors: true, memory: "512MiB", timeoutSeconds: 60 }, async req => {
  const t = req.auth && req.auth.token;
  if (!t || !t.email || !t.email_verified || !ADMINS.includes(String(t.email).toLowerCase())) throw new HttpsError("permission-denied", "This page is private.");
  return h.adminStats({ excludeEmails: ADMINS });   // your own account is left out of the account figures
});
export const deleteAccount = call(h.deleteAccount);
