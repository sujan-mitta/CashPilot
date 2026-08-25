import { redirect } from "next/navigation";

/**
 * This route used to render a fake Google account chooser that posted a
 * fabricated GOOGLE_AUTH_SUCCESS message to the login page, which created a
 * real account from whatever the message claimed. The listener checked no
 * origin, so the identity was attacker-controlled.
 *
 * It is kept only so existing links and bookmarks land somewhere sane, and
 * now starts the real authorization-code flow instead.
 */
export default function GoogleAuthLegacyEntry() {
  redirect("/api/auth/google/start");
}
