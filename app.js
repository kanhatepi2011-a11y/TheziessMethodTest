import {
    clearAllRecords,
    deleteRecord,
    getAllRecords,
    saveRecord,
} from "./db.js";
import { initChangelog } from "./src/changelog.mjs";
import {
    detectVideoCodecFromMoov,
    findHandlerType,
    getBoxHeaderSize,
    parseBoxes,
    updateBoxSize,
    updateChunkOffsets,
} from "./src/mp4-boxes.mjs";
import { inflateSampleTableVideo } from "./src/mp4-inflate.mjs";
import { normalizeContainer } from "./src/mp4-normalize.mjs";

const FRAME_CAPTURE_TIMEOUT_MS = 5000;
const METADATA_TIMEOUT_MS = 10000;
const MAX_THUMBNAIL_DIMENSION = 120;
const MOBILE_BREAKPOINT = 900;
const DOWNLOAD_REVOKE_DELAY_MS = 1000;
const PROGRESS_HIDE_DELAY_MS = 800;
const PROGRESS_FADE_DURATION_MS = 400;
const DOWNLOAD_INTERVAL_MS = 300;
const PATCH_INTERVAL_MS = 600;
const MOBILE_SCROLL_DELAY_MS = 150;
const DOWNLOAD_ANCHOR_CLEANUP_MS = 100;
const SAFE_THUMBNAIL_PREFIX = "data:image/jpeg;base64,";
const TELEGRAM_USER_STORAGE_KEY = "theziess.telegram.user";
const TELEGRAM_CONNECTED_AT_KEY = "theziess.telegram.connectedAt";
const TELEGRAM_FALLBACK_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function readStoredTelegramUser() {
    try {
        const connectedAt = Number(localStorage.getItem(TELEGRAM_CONNECTED_AT_KEY));
        const rawUser = localStorage.getItem(TELEGRAM_USER_STORAGE_KEY);

        if (!rawUser || !Number.isFinite(connectedAt)) return null;

        if (Date.now() - connectedAt > TELEGRAM_FALLBACK_MAX_AGE_MS) {
            clearStoredTelegramUser();
            return null;
        }

        const user = JSON.parse(rawUser);
        if (!user || typeof user !== "object" || !String(user.id || "").trim()) {
            clearStoredTelegramUser();
            return null;
        }

        return {
            id: String(user.id),
            databaseId: String(user.databaseId || ""),
            first_name: String(user.first_name || ""),
            last_name: String(user.last_name || ""),
            username: String(user.username || ""),
            photo_url: String(user.photo_url || ""),
        };
    } catch (error) {
        console.warn("Unable to read saved Telegram login", error);
        return null;
    }
}

function storeTelegramUser(user) {
    if (!user) return;

    try {
        localStorage.setItem(TELEGRAM_USER_STORAGE_KEY, JSON.stringify(user));
        localStorage.setItem(TELEGRAM_CONNECTED_AT_KEY, String(Date.now()));
    } catch (error) {
        console.warn("Unable to save Telegram login", error);
    }
}

function clearStoredTelegramUser() {
    try {
        localStorage.removeItem(TELEGRAM_USER_STORAGE_KEY);
        localStorage.removeItem(TELEGRAM_CONNECTED_AT_KEY);
    } catch (error) {
        console.warn("Unable to clear Telegram login", error);
    }
}


const supportedMimeTypes = [
    "video/mp4",
    "video/quicktime",
    "video/x-quicktime",
];
const supportedExtensions = [".mp4", ".mov"];

const fileInput = document.getElementById("fileInput");
const patchBtn = document.getElementById("patchBtn");
const clearBtn = document.getElementById("clearBtn");
const dropZone = document.getElementById("dropZone");
const statusLog = document.getElementById("statusLog");
const progressBar = document.getElementById("progressBar");
const progressTrack = document.getElementById("progressTrack");
const fileListEl = document.getElementById("fileList");
const historyList = document.getElementById("historyList");
const historyBadge = document.getElementById("historyBadge");
const historyHeader = document.getElementById("historyHeader");
const clearHistoryBtn = document.getElementById("clearHistoryBtn");

let selectedFiles = [];
let currentFlowState = "idle";
let isCancelled = false;
let processingFiles = false;
let lastPatchedVfi = false;
let lastPatchedRes = "1080";

let currentUser = null;
let currentSubscription = null;
let pendingPlan = null;

const PLANS = {
    free: { id: "free", name: "FREE", price: "$0", durationLabel: "3 days", days: 3 },
    pro: { id: "pro", name: "PRO", price: "$2", durationLabel: "30 days", days: 30 },
    premium: { id: "premium", name: "PREMIUM", price: "$5", durationLabel: "120 days", days: 120 },
    max: { id: "max", name: "MAX", price: "$10", durationLabel: "Unlimited", days: null },
};

function hasActiveSubscription() {
    if (!currentUser || !currentSubscription) {
        return false;
    }

    if (currentSubscription.status !== "active") {
        return false;
    }

    if (currentSubscription.planId === "max") {
        return true;
    }

    return Number(currentSubscription.expiresAt) > Date.now();
}

function formatSubscriptionExpiry(subscription) {
    if (!subscription) return "No active subscription";
    if (subscription.planId === "max") return "MAX · Unlimited";
    return `${PLANS[subscription.planId]?.name || "PLAN"} · until ${new Date(subscription.expiresAt).toLocaleDateString()}`;
}

function getTelegramDisplayName(user) {
    if (!user) return "Telegram User";
    const fullName = [user.first_name, user.last_name]
        .map((part) => String(part || "").trim())
        .filter(Boolean)
        .join(" ");
    return fullName || user.username || "Telegram User";
}

function getTelegramInitials(user) {
    const displayName = getTelegramDisplayName(user);
    const initials = displayName
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part.charAt(0).toUpperCase())
        .join("");
    return initials || "T";
}

function setElementText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
}

function updateTelegramProfileUI(loggedIn, active) {
    const displayName = getTelegramDisplayName(currentUser);
    const username = currentUser?.username
        ? `@${currentUser.username}`
        : loggedIn
          ? "No public username"
          : "Not connected";
    const photoUrl = String(currentUser?.photo_url || "").trim();
    const plan = active ? PLANS[currentSubscription?.planId] : null;

    const accountCard = document.getElementById("telegramAccountCard");
    const accountPhoto = document.getElementById("telegramAccountPhoto");
    const profileAvatar = document.getElementById("profileAvatar");
    const profileInitials = document.getElementById("profileInitials");
    const profileConnectionStatus = document.getElementById("profileConnectionStatus");
    const profilePlanBadge = document.getElementById("profilePlanBadge");
    const profileConnectedIndicator = document.querySelector(".profile-connected-indicator");
    const navProfileDot = document.getElementById("navProfileDot");

    if (accountCard) accountCard.hidden = !loggedIn;
    setElementText("telegramAccountName", displayName);
    setElementText("telegramAccountUsername", username);
    setElementText(
        "telegramAccountPlan",
        active
            ? formatSubscriptionExpiry(currentSubscription)
            : loggedIn
              ? "No active subscription"
              : "Login required",
    );

    const configurePhoto = (image, initialsElement = null) => {
        if (!image) return;
        if (loggedIn && photoUrl) {
            image.src = photoUrl;
            image.hidden = false;
            if (initialsElement) initialsElement.hidden = true;
            image.onerror = () => {
                image.hidden = true;
                image.removeAttribute("src");
                if (initialsElement) initialsElement.hidden = false;
            };
        } else {
            image.hidden = true;
            image.removeAttribute("src");
            if (initialsElement) initialsElement.hidden = false;
        }
    };

    configurePhoto(accountPhoto);
    configurePhoto(profileAvatar, profileInitials);

    if (profileInitials) {
        profileInitials.textContent = getTelegramInitials(currentUser);
        profileInitials.hidden = loggedIn && Boolean(photoUrl);
    }

    setElementText("profileName", loggedIn ? displayName : "Telegram User");
    setElementText("profileUsername", username);
    setElementText("profileTelegramId", loggedIn ? String(currentUser.id || "—") : "—");
    setElementText(
        "profileAccessLevel",
        active
            ? "Compressor unlocked"
            : loggedIn
              ? "Subscription required"
              : "Login required",
    );
    setElementText("profileConnectionStatus", loggedIn ? "Telegram connected" : "Telegram not connected");

    if (profileConnectionStatus) {
        profileConnectionStatus.classList.toggle("offline", !loggedIn);
    }
    if (profileConnectedIndicator) profileConnectedIndicator.hidden = !loggedIn;
    if (navProfileDot) navProfileDot.hidden = !loggedIn;

    if (active && plan) {
        const isFreeTrial = currentSubscription.planId === "free";
        setElementText("profilePlanName", plan.name);
        setElementText(
            "profilePlanBadge",
            isFreeTrial ? "Free trial active" : "Subscription active",
        );
        setElementText("profilePlanStatus", "Active");
        setElementText(
            "profilePlanExpiry",
            currentSubscription.planId === "max"
                ? "Unlimited"
                : new Date(currentSubscription.expiresAt).toLocaleDateString(),
        );
        setElementText(
            "profilePlanDescription",
            isFreeTrial
                ? "Your one-time 3-day free trial is active."
                : `${plan.name} is active. Payment method: ${currentSubscription.paymentMethod || "KHQR"}.`,
        );
        profilePlanBadge?.classList.toggle("premium", !isFreeTrial);
        profilePlanBadge?.classList.toggle("trial", isFreeTrial);
    } else if (loggedIn) {
        setElementText("profilePlanName", "NO PLAN");
        setElementText("profilePlanBadge", "Subscription required");
        setElementText("profilePlanStatus", "Inactive");
        setElementText("profilePlanExpiry", "—");
        setElementText(
            "profilePlanDescription",
            "Choose the FREE 3-day trial, PRO, PREMIUM, or MAX to unlock video compression.",
        );
        profilePlanBadge?.classList.remove("premium", "trial");
    } else {
        setElementText("profilePlanName", "NOT CONNECTED");
        setElementText("profilePlanBadge", "Login required");
        setElementText("profilePlanStatus", "Inactive");
        setElementText("profilePlanExpiry", "—");
        setElementText(
            "profilePlanDescription",
            "Connect your Telegram account to unlock the video compressor and view subscription details.",
        );
        profilePlanBadge?.classList.remove("premium", "trial");
    }

    const profileLoginBtn = document.getElementById("profileLoginBtn");
    const profilePlansBtn = document.getElementById("profilePlansBtn");
    const profileLogoutBtn = document.getElementById("profileLogoutBtn");
    if (profileLoginBtn) profileLoginBtn.hidden = loggedIn;
    if (profilePlansBtn) profilePlansBtn.hidden = !loggedIn;
    if (profileLogoutBtn) profileLogoutBtn.hidden = !loggedIn;
}

function openModal(id) { document.getElementById(id)?.classList.add("active"); }
function closeModal(id) { document.getElementById(id)?.classList.remove("active"); }

function configurePlanActivationModal(plan) {
    const isFreeTrial = plan?.id === "free";
    const paymentBody = document.getElementById("paymentBody");
    const khqrCard = document.getElementById("khqrCard");
    const paymentNotice = document.getElementById("paymentNotice");
    const confirmButton = document.getElementById("confirmPaymentBtn");

    setElementText(
        "paymentModalTitle",
        isFreeTrial ? "Activate 3-Day Free Trial" : "KHQR Demo Payment",
    );
    setElementText("paymentAmount", plan?.price || "$0");
    setElementText("paymentPlanName", plan?.name || "—");
    setElementText("paymentDuration", plan?.durationLabel || "—");

    paymentBody?.classList.toggle("free-trial-mode", isFreeTrial);
    if (khqrCard) khqrCard.hidden = isFreeTrial;
    if (paymentNotice) {
        paymentNotice.classList.remove("error");
        paymentNotice.textContent = isFreeTrial
            ? "This free trial can be activated once per Telegram account. The 3-day period starts immediately after confirmation."
            : "នេះជា Demo KHQR មិនទទួលប្រាក់ពិតទេ។ ចុច “Confirm Demo Payment” ដើម្បី Activate plan សាកល្បង។";
    }
    if (confirmButton) {
        confirmButton.textContent = isFreeTrial
            ? "Start 3-Day Free Trial"
            : "Confirm Demo Payment";
    }
}

function showSubscriptionPlans() {
    closeModal("profileModal");
    focusNavigationSection(document.getElementById("subscriptionPanel"));
}

function updateAccessUI() {
    const loggedIn = !!currentUser;
    const active = hasActiveSubscription();
    const accountLabel = document.getElementById("accountLabel");
    const loginBtn = document.getElementById("telegramLoginBtn");
    const logoutBtn = document.getElementById("logoutBtn");
    const subscriptionStatus = document.getElementById("subscriptionStatus");
    const lock = document.getElementById("accessLock");
    if (accountLabel) accountLabel.textContent = loggedIn ? `@${currentUser.username || currentUser.first_name || "telegram_user"}` : "មិនទាន់ចូលគណនី";
    if (loginBtn) loginBtn.hidden = loggedIn;
    if (logoutBtn) logoutBtn.hidden = !loggedIn;
    if (subscriptionStatus) {
        subscriptionStatus.textContent = active
            ? formatSubscriptionExpiry(currentSubscription)
            : loggedIn
              ? "Subscription required"
              : "Login required";
        subscriptionStatus.classList.toggle("active", active);
        subscriptionStatus.classList.toggle("connected", false);
        subscriptionStatus.classList.toggle("required", loggedIn && !active);
    }
    document.querySelectorAll(".plan-card").forEach((card) => {
        const isCurrent = active && card.dataset.plan === currentSubscription?.planId;
        const freeBlockedByActivePlan = active && card.dataset.plan === "free";
        card.classList.toggle("current", isCurrent);
        card.disabled = freeBlockedByActivePlan;
        if (freeBlockedByActivePlan) {
            card.title = isCurrent
                ? "Your free trial is already active."
                : "You already have an active subscription.";
        } else {
            card.removeAttribute("title");
        }
    });

    // Telegram login unlocks the account area, but video compression requires
    // a currently active subscription. The full-page lock remains login-only.
    document.body.classList.toggle("access-granted", loggedIn);
    if (lock) lock.hidden = loggedIn;
    updateTelegramProfileUI(loggedIn, active);
    updatePatchButton();
}

function requireLogin() {
    if (currentUser) return true;
    openModal("telegramModal");
    updateAccessUI();
    return false;
}

function requireActiveSubscription({ focusPlans = true } = {}) {
    if (!requireLogin()) return false;
    if (hasActiveSubscription()) return true;

    logMessage(
        "Choose the FREE 3-day trial or an active paid plan before compressing videos.",
        "warning",
    );

    if (focusPlans) {
        focusNavigationSection(document.getElementById("subscriptionPanel"));
    }

    updateAccessUI();
    return false;
}

async function loadServerSession({ retries = 2 } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
            const response = await fetch(`/api/auth/me?t=${Date.now()}`, {
                credentials: "include",
                cache: "no-store",
                headers: { Accept: "application/json" },
            });

            if (!response.ok) {
                throw new Error(`Unable to read login session (${response.status})`);
            }

            const data = await response.json();

            if (data.authenticated && data.user) {
                currentUser = data.user;
                currentSubscription = data.subscription || null;
                storeTelegramUser(data.user);
                updateAccessUI();
                return true;
            }

            const storedUser = readStoredTelegramUser();
            currentUser = storedUser;
            currentSubscription = null;
            updateAccessUI();
            return Boolean(storedUser);
        } catch (error) {
            lastError = error;

            if (attempt < retries) {
                await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
            }
        }
    }

    const storedUser = readStoredTelegramUser();
    currentUser = storedUser;
    currentSubscription = null;

    if (lastError) {
        console.warn("Server session unavailable; using Telegram browser fallback", lastError);
    }

    updateAccessUI();
    return Boolean(storedUser);
}


async function initializeMembership() {
    
    const params = new URLSearchParams(location.search);
    const returningFromTelegram = params.get("telegram_login") === "success";
    await loadServerSession({ retries: returningFromTelegram ? 4 : 2 });
    if (params.get("telegram_login") === "success") {
        params.delete("telegram_login");
        history.replaceState({}, "", `${location.pathname}${params.toString() ? `?${params}` : ""}${location.hash}`);
        if (currentUser) {
            logMessage(
                hasActiveSubscription()
                    ? "Telegram account verified. Your subscription is active."
                    : "Telegram account verified. Choose a subscription plan to enable compression.",
                hasActiveSubscription() ? "success" : "warning",
            );
        } else {
            logMessage("Telegram returned successfully, but the login session could not be loaded. Please try logging in again.", "error");
        }
    }
    document.getElementById("telegramLoginBtn")?.addEventListener("click", () => openModal("telegramModal"));

    const telegramOidcLoginBtn = document.getElementById("telegramOidcLoginBtn");
    const telegramLoginError = document.getElementById("telegramLoginError");
    const telegramCallbackUrl = document.getElementById("telegramCallbackUrl");

    if (telegramCallbackUrl) {
        telegramCallbackUrl.textContent = `${location.origin}/api/auth/telegram/callback`;
    }

    const resetTelegramLoginButton = () => {
        if (!telegramOidcLoginBtn) return;
        telegramOidcLoginBtn.disabled = false;
        telegramOidcLoginBtn.removeAttribute("aria-busy");
        const label = telegramOidcLoginBtn.querySelector("span");
        if (label) label.textContent = "Continue with Telegram";
    };

    telegramOidcLoginBtn?.addEventListener("click", () => {
        if (telegramLoginError) {
            telegramLoginError.hidden = true;
            telegramLoginError.textContent = "";
        }

        telegramOidcLoginBtn.disabled = true;
        telegramOidcLoginBtn.setAttribute("aria-busy", "true");
        const label = telegramOidcLoginBtn.querySelector("span");
        if (label) label.textContent = "Connecting to Telegram…";

        // Start the server-side OIDC + PKCE flow. The previous build had no
        // click handler here, so the button looked active but did nothing.
        window.location.assign("/api/auth/telegram");
    });

    // Browsers may restore the page from the back-forward cache after a user
    // cancels Telegram login. Re-enable the button in that case.
    window.addEventListener("pageshow", resetTelegramLoginButton);

    document.getElementById("openPlansBtn")?.addEventListener("click", showSubscriptionPlans);
    document.getElementById("logoutBtn")?.addEventListener("click", async () => {
        try {
            await fetch("/api/auth/logout", {
                method: "POST",
                credentials: "include",
                cache: "no-store",
            });
        } catch (error) {
            console.warn("Server logout failed; clearing local login anyway", error);
        }

        clearStoredTelegramUser();
        currentUser = null;
        currentSubscription = null;
        updateAccessUI();
    });
    document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.closeModal)));
    document.querySelectorAll(".plan-card").forEach((card) => card.addEventListener("click", () => {
        if (!currentUser) { openModal("telegramModal"); return; }
        pendingPlan = PLANS[card.dataset.plan];
        if (!pendingPlan) return;
        configurePlanActivationModal(pendingPlan);
        openModal("paymentModal");
    }));
    document.getElementById("confirmPaymentBtn")?.addEventListener("click", async () => {
        if (!pendingPlan || !currentUser) return;
        const button = document.getElementById("confirmPaymentBtn");
        button.disabled = true;
        try {
            const response = await fetch("/api/subscription/activate-demo", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ planId: pendingPlan.id }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || "Demo activation failed");
            const activatedPlan = pendingPlan;
            currentSubscription = data.subscription;
            pendingPlan = null;
            closeModal("paymentModal");
            logMessage(
                activatedPlan.id === "free"
                    ? "Your 3-day free trial is now active."
                    : `${activatedPlan.name} subscription activated (KHQR demo).`,
                "success",
            );
            updateAccessUI();
        } catch (error) {
            const paymentNotice = document.getElementById("paymentNotice");
            if (paymentNotice) {
                paymentNotice.textContent = error.message;
                paymentNotice.classList.add("error");
            }
            logMessage(error.message, "error");
        } finally {
            button.disabled = false;
        }
    });
    document.getElementById("patchAccessHint")?.addEventListener("click", () => {
        if (!currentUser) {
            openModal("telegramModal");
            return;
        }
        showSubscriptionPlans();
    });
    document.getElementById("lockActionBtn")?.addEventListener("click", () => openModal("telegramModal"));
    updateAccessUI();
}

let lastWidth = null;
function adjustMobileLayout() {
    const currentWidth = window.innerWidth;
    if (lastWidth !== null && currentWidth === lastWidth) return;
    lastWidth = currentWidth;

    const isMobile = currentWidth <= MOBILE_BREAKPOINT;
    const header = document.querySelector(".header");
    const panelHeader = header ? header.parentNode : null;
    const panelLeft = document.querySelector(".panel-left");
    const panelRight = document.querySelector(".panel-right");
    const dropZoneEl = document.getElementById("dropZone");
    if (isMobile) {
        if (dropZoneEl && panelHeader && dropZoneEl.parentNode !== panelHeader) {
            panelHeader.after(dropZoneEl);
        }
    } else {
        if (dropZoneEl && panelRight && dropZoneEl.parentNode !== panelRight) {
            panelRight.insertBefore(dropZoneEl, panelRight.firstChild);
        }
    }
}

function setActiveNavigation(view) {
    document.querySelectorAll(".app-nav-button").forEach((button) => {
        const isActive = button.dataset.view === view;
        button.classList.toggle("active", isActive);
        if (isActive) {
            button.setAttribute("aria-current", "page");
        } else {
            button.removeAttribute("aria-current");
        }
    });
}

function focusNavigationSection(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.classList.remove("nav-highlight");
    requestAnimationFrame(() => {
        element.classList.add("nav-highlight");
        window.setTimeout(() => element.classList.remove("nav-highlight"), 950);
    });
}

function initializeBottomNavigation() {
    const compressButton = document.getElementById("navCompressBtn");
    const historyButton = document.getElementById("navHistoryBtn");
    const profileButton = document.getElementById("navProfileBtn");
    const profileModal = document.getElementById("profileModal");

    compressButton?.addEventListener("click", () => {
        if (!requireLogin()) return;
        setActiveNavigation("compress");
        focusNavigationSection(dropZone);
    });

    historyButton?.addEventListener("click", async () => {
        if (!requireLogin()) return;
        await renderHistoryList();
        const historyContainer = historyHeader?.parentElement;
        historyContainer?.classList.remove("collapsed");
        document.getElementById("historyToggleBtn")?.setAttribute("aria-expanded", "true");
        setActiveNavigation("history");
        focusNavigationSection(historyContainer);
    });

    profileButton?.addEventListener("click", () => {
        updateAccessUI();
        setActiveNavigation("profile");
        openModal("profileModal");
    });

    document.getElementById("profileLoginBtn")?.addEventListener("click", () => {
        closeModal("profileModal");
        openModal("telegramModal");
    });

    document.getElementById("profilePlansBtn")?.addEventListener("click", () => {
        closeModal("profileModal");
        setActiveNavigation("profile");
        focusNavigationSection(document.getElementById("subscriptionPanel"));
    });

    document.getElementById("profileLogoutBtn")?.addEventListener("click", () => {
        closeModal("profileModal");
        document.getElementById("logoutBtn")?.click();
        setActiveNavigation("compress");
    });

    profileModal?.addEventListener("click", (event) => {
        if (event.target === profileModal) {
            closeModal("profileModal");
        }
    });

    setActiveNavigation("compress");
}

function initializeApp() {
    initializeMembership();
    renderHistoryList();
    initializeBottomNavigation();
    adjustMobileLayout();
    window.addEventListener("resize", adjustMobileLayout);

    const copyBtn = document.getElementById("copyLogBtn");
    const copyToast = document.getElementById("copyLogToast");
    if (copyBtn) {
        let toastTimer = null;
        copyBtn.addEventListener("click", async () => {
            const text = [...statusLog.querySelectorAll(".log-row")]
                .map((r) => r.textContent)
                .join("\n");
            if (!text) return;
            try {
                await navigator.clipboard.writeText(text);
                if (copyToast) {
                    copyToast.textContent = "Copied";
                    copyToast.classList.add("show");
                    clearTimeout(toastTimer);
                    toastTimer = setTimeout(() => {
                        copyToast.classList.remove("show");
                    }, 1500);
                }
            } catch {
                if (copyToast) {
                    copyToast.textContent = "Copy failed";
                    copyToast.classList.add("show");
                    clearTimeout(toastTimer);
                    toastTimer = setTimeout(() => {
                        copyToast.classList.remove("show");
                    }, 1500);
                }
            }
        });
    }
}

function logMessage(text, type = "info") {
    const row = document.createElement("div");
    row.className = `log-row log-${type}`;
    row.textContent = text;
    statusLog.appendChild(row);
    statusLog.scrollTop = statusLog.scrollHeight;
}

function clearLog() {
    statusLog.innerHTML = "";
}

function setLogCopyVisible(visible) {
    const copyBtn = document.getElementById("copyLogBtn");
    if (copyBtn) copyBtn.classList.toggle("visible", visible);
}

function setProgress(percent) {
    progressBar.style.width = `${percent}%`;
}

function showProgress() {
    progressTrack.classList.add("active");
    progressTrack.style.opacity = "1";
}

function hideProgress() {
    setTimeout(() => {
        progressTrack.style.opacity = "0";
        setTimeout(() => {
            setProgress(0);
            progressTrack.classList.remove("active");
        }, PROGRESS_FADE_DURATION_MS);
    }, PROGRESS_HIDE_DELAY_MS);
}

function isSupportedFile(file) {
    const lowerName = file.name.toLowerCase();
    return (
        supportedMimeTypes.includes(file.type) ||
        supportedExtensions.some((ext) => lowerName.endsWith(ext))
    );
}

function getMimeType(file) {
    return "video/mp4";
}

function isMovFile(file) {
    const lowerName = file.name.toLowerCase();
    if (lowerName.endsWith(".mov")) return true;
    if (file.type === "video/quicktime" || file.type === "video/x-quicktime")
        return true;
    return false;
}

function getOutputFilename() {
    const randomNumber = crypto.getRandomValues(new Uint32Array(1))[0]
        .toString()
        .padStart(10, "0")
        .slice(0, 10);
    return `@theziess.method_${randomNumber}.mp4`;
}

function captureVideoFrame(file) {
    return new Promise((resolve) => {
        const video = document.createElement("video");
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        let settled = false;
        let objectUrl = null;

        function cleanup(result) {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            video.onloadeddata = null;
            video.onseeked = null;
            video.onerror = null;
            video.src = "";
            video.load();
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
            resolve(result);
        }

        // Set event handlers BEFORE assigning src to prevent race condition
        video.onloadeddata = () => {
            if (settled) return;
            video.currentTime = 0.1;
        };

        video.onseeked = () => {
            if (settled) return;
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d");
            const maxDimension = MAX_THUMBNAIL_DIMENSION;
            let width = video.videoWidth;
            let height = video.videoHeight;

            if (width > height) {
                if (width > maxDimension) {
                    height = Math.round((height * maxDimension) / width);
                    width = maxDimension;
                }
            } else {
                if (height > maxDimension) {
                    width = Math.round((width * maxDimension) / height);
                    height = maxDimension;
                }
            }

            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(video, 0, 0, width, height);

            const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
            cleanup(dataUrl);
        };

        video.onerror = () => {
            cleanup(null);
        };

        // Assign src AFTER handlers are set
        objectUrl = URL.createObjectURL(file);
        const timeoutId = setTimeout(() => {
            cleanup(null);
        }, FRAME_CAPTURE_TIMEOUT_MS);

        video.src = objectUrl;
    });
}

function formatFileSize(bytes) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} GB`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function downloadBuffer(data, filename, mimeType) {
    const blob =
        data instanceof Blob ? data : new Blob([data], { type: mimeType });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    setTimeout(() => {
        document.body.removeChild(anchor);
    }, DOWNLOAD_ANCHOR_CLEANUP_MS);
    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, DOWNLOAD_REVOKE_DELAY_MS);
}

function getStatusLabel(status) {
    return (
        {
            pending: "Pending",
            processing: "Processing",
            success: "Done",
            error: "Error",
        }[status] || status
    );
}

function renderFileList() {
    fileListEl.innerHTML = "";

    if (selectedFiles.length === 0) {
        fileListEl.style.display = "none";
        clearBtn.style.display = "none";
        return;
    }

    fileListEl.style.display = "flex";
    clearBtn.style.display = "inline-flex";

    let index = 0;
    for (const item of selectedFiles) {
        const removeIndex = index;
        const row = document.createElement("div");
        row.className = `file-item status-${item.status}`;

        const checkboxWrapper = document.createElement("label");
        checkboxWrapper.className = "custom-checkbox";
        const checkboxInput = document.createElement("input");
        checkboxInput.type = "checkbox";
        checkboxInput.checked = item.checked;
        if (
            currentFlowState !== "completed" ||
            item.status !== "success" ||
            !item.patchedBuffer
        ) {
            checkboxInput.disabled = true;
        }
        checkboxInput.addEventListener("change", () => {
            item.checked = checkboxInput.checked;
            updatePatchButton();
        });
        const checkboxSpan = document.createElement("span");
        checkboxSpan.className = "checkbox-mark";
        checkboxWrapper.appendChild(checkboxInput);
        checkboxWrapper.appendChild(checkboxSpan);
        row.appendChild(checkboxWrapper);

        const body = document.createElement("div");
        body.className = "file-item-body";

        const name = document.createElement("div");
        name.className = "file-item-name";
        name.textContent = item.name;

        const meta = document.createElement("div");
        meta.className = "file-item-meta";
        meta.textContent = formatFileSize(item.size);

        const fileProgressTrack = document.createElement("div");
        fileProgressTrack.className = "file-item-progress";
        const fileProgressBar = document.createElement("div");
        fileProgressBar.className = "file-item-progress-bar";
        fileProgressTrack.appendChild(fileProgressBar);

        body.appendChild(name);
        body.appendChild(meta);
        body.appendChild(fileProgressTrack);

        const icon = document.createElement("div");
        icon.className = "file-item-icon";
        const iconEl = document.createElement("i");
        iconEl.className = "ri-movie-2-fill";
        icon.appendChild(iconEl);

        row.appendChild(icon);
        row.appendChild(body);

        const right = document.createElement("div");
        right.className = "file-item-right";

        const badge = document.createElement("span");
        badge.className = `file-badge badge-${item.status}`;
        badge.textContent = getStatusLabel(item.status);
        right.appendChild(badge);

        if (item.status === "pending" && currentFlowState !== "patching") {
            const removeBtn = document.createElement("button");
            removeBtn.className = "file-remove-btn";
            const removeIcon = document.createElement("i");
            removeIcon.className = "ri-close-fill";
            removeBtn.appendChild(removeIcon);
            removeBtn.addEventListener("click", (event) => {
                event.stopPropagation();
                removeFile(removeIndex);
            });
            right.appendChild(removeBtn);
        }

        row.appendChild(right);
        fileListEl.appendChild(row);
        index++;
    }
    // Remix Icon CSS handles rendering
}

async function addFiles(fileList) {
    if (!requireLogin()) return;
    if (processingFiles || currentFlowState === "patching") return;
    processingFiles = true;
    try {
        const filesArray = Array.from(fileList);
        if (currentFlowState === "completed") {
            selectedFiles = [];
            currentFlowState = "idle";
            setLogCopyVisible(false);
        }
        let skipped = 0;
        for (const file of filesArray) {
            if (!isSupportedFile(file)) {
                skipped++;
                continue;
            }
            const isDupe = selectedFiles.some(
                (f) => f.name === file.name && f.size === file.size,
            );
            if (isDupe) {
                logMessage(
                    `Duplicate file detected: "${file.name}". Skipping.`,
                    "warning",
                );
                continue;
            }
            selectedFiles.push({
                file,
                name: file.name,
                size: file.size,
                status: "pending",
                patchedBuffer: null,
                outputName: null,
                mimeType: null,
                checked: true,
            });
        }
        if (skipped > 0) logMessage(`${skipped} file(s) skipped.`, "warning");
        renderFileList();
        updatePatchButton();
        if (window.innerWidth <= MOBILE_BREAKPOINT) {
            setTimeout(() => {
                const controlBox = document.querySelector(".control-box");
                if (controlBox) {
                    controlBox.scrollIntoView({
                        behavior: "smooth",
                        block: "start",
                    });
                }
            }, MOBILE_SCROLL_DELAY_MS);
        }
    } finally {
        processingFiles = false;
    }
}

function removeFile(index) {
    if (currentFlowState === "patching") return;
    selectedFiles.splice(index, 1);
    if (selectedFiles.length === 0) {
        currentFlowState = "idle";
    }
    renderFileList();
    updatePatchButton();
}

function updatePatchButton() {
    const label = patchBtn.querySelector("span");
    const hint = document.getElementById("patchAccessHint");

    if (!currentUser) {
        patchBtn.disabled = true;
        patchBtn.dataset.accessState = "login-required";
        patchBtn.title = "Login with Telegram before compressing a video.";
        if (label) label.textContent = "Login Required";
        if (hint) {
            hint.hidden = false;
            hint.textContent = "Login with Telegram, then choose the FREE 3-day trial or a paid plan.";
            hint.dataset.action = "login";
        }
        return;
    }

    if (!hasActiveSubscription()) {
        patchBtn.disabled = true;
        patchBtn.dataset.accessState = "subscription-required";
        patchBtn.title = "Activate FREE, PRO, PREMIUM, or MAX to unlock video compression.";
        if (label) label.textContent = "Subscription Required";
        if (hint) {
            hint.hidden = false;
            hint.textContent = "No active subscription. Click here to view FREE, PRO, PREMIUM, or MAX plans.";
            hint.dataset.action = "plans";
        }
        return;
    }

    patchBtn.dataset.accessState = "active";
    patchBtn.removeAttribute("title");
    if (hint) hint.hidden = true;
    const failedCount = selectedFiles.filter(
        (f) => f.status === "error",
    ).length;
    if (failedCount > 0) {
        patchBtn.disabled = false;
        const retryLabel =
            failedCount > 1 ? `Retry Failed (${failedCount})` : "Retry Failed";
        patchBtn.querySelector("span").textContent = retryLabel;
        return;
    }

    if (currentFlowState === "completed") {
        const currentVfi = !!enableInterpolation?.checked;
        const currentRes =
            document.getElementById("outputResolution")?.value || "1080";
        const settingsChanged =
            currentVfi !== lastPatchedVfi || currentRes !== lastPatchedRes;

        if (settingsChanged) {
            patchBtn.disabled = false;
            patchBtn.querySelector("span").textContent = "Repatch";
        } else {
            const checkedCount = selectedFiles.filter(
                (f) => f.status === "success" && f.checked && f.patchedBuffer,
            ).length;
            patchBtn.disabled = checkedCount === 0;
            const label =
                checkedCount > 1
                    ? `Download Selected (${checkedCount})`
                    : checkedCount > 0
                      ? "Download Selected"
                      : "Patch Videos";
            patchBtn.querySelector("span").textContent = label;
        }
    } else {
        const pendingCount = selectedFiles.filter(
            (f) => f.status === "pending",
        ).length;
        patchBtn.disabled =
            pendingCount === 0 || currentFlowState === "patching";
        const label =
            pendingCount > 1
                ? `Patch Videos (${pendingCount})`
                : "Patch Videos";
        patchBtn.querySelector("span").textContent = label;
    }
}

function getDimensionsFromMp4Container(bytes, view) {
    const top = parseBoxes(bytes, view, 0, bytes.length);
    const moov = top.find((b) => b.type === "moov");
    if (!moov) return null;

    const moovCh = parseBoxes(
        bytes,
        view,
        moov.offset + getBoxHeaderSize(moov),
        moov.end,
    );
    for (const trak of moovCh.filter((b) => b.type === "trak")) {
        const tch = parseBoxes(
            bytes,
            view,
            trak.offset + getBoxHeaderSize(trak),
            trak.end,
        );
        const tkhd = tch.find((b) => b.type === "tkhd");
        const mdia = tch.find((b) => b.type === "mdia");
        if (!tkhd || !mdia) continue;

        const mch = parseBoxes(
            bytes,
            view,
            mdia.offset + getBoxHeaderSize(mdia),
            mdia.end,
        );
        const hdlr = mch.find((b) => b.type === "hdlr");
        if (!hdlr) continue;
        if (findHandlerType(bytes, hdlr) !== "vide") continue;

        const cs = tkhd.offset + getBoxHeaderSize(tkhd);
        const ver = bytes[cs];
        const matrixOff = cs + (ver === 0 ? 40 : 52);
        const widthOff = cs + (ver === 0 ? 76 : 88);

        if (widthOff + 8 > tkhd.end) continue;

        let w = view.getUint32(widthOff, false) >> 16;
        let h = view.getUint32(widthOff + 4, false) >> 16;

        if (matrixOff + 36 <= tkhd.end) {
            const a = view.getInt32(matrixOff, false);
            const b = view.getInt32(matrixOff + 4, false);
            const isRotated90 = Math.abs(a) < 1000 && Math.abs(b) > 60000;
            if (isRotated90) {
                [w, h] = [h, w];
            }
        }

        if (w > 0 && h > 0) return { width: w, height: h };
    }
    return null;
}

function getVideoDurationAndResolution(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const ab = e.target.result;
            const bytes = new Uint8Array(ab);
            const view = new DataView(ab);
            const containerDims = getDimensionsFromMp4Container(bytes, view);

            const video = document.createElement("video");
            video.preload = "metadata";
            video.muted = true;
            video.playsInline = true;
            let settled = false;
            let objectUrl = null;

            function cleanup(result) {
                if (settled) return;
                settled = true;
                clearTimeout(timeoutId);
                video.onloadedmetadata = null;
                video.onerror = null;
                video.src = "";
                video.load();
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                resolve(result);
            }

            objectUrl = URL.createObjectURL(file);
            const timeoutId = setTimeout(() => {
                if (containerDims) {
                    cleanup({
                        duration: 0,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else {
                    cleanup(null);
                }
            }, METADATA_TIMEOUT_MS);

            video.src = objectUrl;
            video.onloadedmetadata = () => {
                if (settled) return;
                const bw = video.videoWidth;
                const bh = video.videoHeight;
                const duration = video.duration;
                if (
                    containerDims &&
                    (bw === 0 || bh === 0 || !Number.isFinite(duration))
                ) {
                    cleanup({
                        duration: 0,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else if (containerDims) {
                    cleanup({
                        duration,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else {
                    cleanup({ duration, width: bw, height: bh });
                }
            };
            video.onerror = () => {
                if (containerDims) {
                    cleanup({
                        duration: 0,
                        width: containerDims.width,
                        height: containerDims.height,
                    });
                } else {
                    cleanup(null);
                }
            };
        };
        reader.onerror = () => resolve(null);
        reader.readAsArrayBuffer(file);
    });
}

let ffmpegInstance = null;

async function destroyFFmpegInstance() {
    if (!ffmpegInstance) return;
    try {
        await ffmpegInstance.terminate();
    } catch (err) {
        console.error("FFmpeg terminate failed:", err);
    }
    ffmpegInstance = null;
}

async function getFFmpeg() {
    if (ffmpegInstance) return ffmpegInstance;

    const { FFmpeg } = await import("@ffmpeg/ffmpeg");

    ffmpegInstance = new FFmpeg();
    logMessage("Loading VFI engine...", "info");
    const isMultiThread =
        typeof window.SharedArrayBuffer !== "undefined" &&
        window.crossOriginIsolated;
    const repoBase =
        location.pathname.substring(0, location.pathname.lastIndexOf("/") + 1) ||
        "/";
    const absBase = new URL(repoBase, location.href).href;
    const baseURL = `${absBase}${isMultiThread ? "ffmpeg-core-mt" : "ffmpeg-core"}`;
    ffmpegInstance.on("progress", ({ progress }) => {
        setProgress(Math.round(progress * 100));
    });
    try {
        const loadConfig = {
            coreURL: `${baseURL}/ffmpeg-core.js`,
            wasmURL: `${baseURL}/ffmpeg-core.wasm`,
            classWorkerURL: `${absBase}ffmpeg-worker/worker.js`,
        };
        if (isMultiThread) {
            loadConfig.workerURL = `${baseURL}/ffmpeg-core.worker.js`;
        }
        await ffmpegInstance.load(loadConfig);
        logMessage("VFI engine loaded successfully.", "success");
    } catch (err) {
        await destroyFFmpegInstance();
        throw err;
    }
    return ffmpegInstance;
}

function resolveInputExtension(file) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".mov")) return ".mov";
    if (lower.endsWith(".webm")) return ".webm";
    return ".mp4";
}

async function runVFI(file, width, height, targetRes = 1080) {
    const { fetchFile } = await import("@ffmpeg/util");

    let instance;
    try {
        if (isCancelled) throw new Error("Cancelled");
        instance = await getFFmpeg();
        if (isCancelled) throw new Error("Cancelled");
        const ext = resolveInputExtension(file);
        const inputName = `input${ext}`;
        const outputName = "output.mp4";

        logMessage("Preparing video data streams...", "info");
        await instance.writeFile(inputName, await fetchFile(file));
        if (isCancelled) throw new Error("Cancelled");

        const isMultiThread =
            typeof window.SharedArrayBuffer !== "undefined" &&
            window.crossOriginIsolated;
        const threads = Math.max(1, Math.floor((navigator.hardwareConcurrency || 4) / 2));
        if (!isMultiThread) {
            logMessage(
                "Notice: Single-threaded mode active. Enable HTTPS/cross-origin isolation for faster processing.",
                "warning",
            );
        }

        const vfiRes = Math.min(targetRes, 1080);
        const meMode = isMobileDevice() ? "bidir" : "bilat";
        const buildFilter = () => {
            let f =
                `mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=${meMode}:me=epzs:search_param=4:scd=none`;
            if (width > height) {
                f = `scale=-2:${vfiRes},${f}`;
            } else {
                f = `scale=${vfiRes}:-2,${f}`;
            }
            if (vfiRes !== targetRes) {
                if (width > height) {
                    f = `${f},scale=-2:${targetRes}:flags=lanczos`;
                } else {
                    f = `${f},scale=${targetRes}:-2:flags=lanczos`;
                }
            }
            return f;
        };
        const buildArgs = (filter, out, extra = []) => [
            "-y",
            "-loglevel",
            "error",
            "-i",
            inputName,
            "-vf",
            filter,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "20",
            ...extra,
            "-video_track_timescale",
            "90000",
            "-threads",
            String(threads),
            out,
        ];
        const runAndRead = async (args, out, keepFile = false) => {
            let ffmpegLog = "";
            const logHandler = ({ message }) => {
                ffmpegLog += message + "\n";
            };
            instance.on("log", logHandler);
            const ret = await instance.exec(args);
            instance.off?.("log", logHandler);
            if (ret !== 0) {
                const tail = ffmpegLog.trim().split("\n").slice(-12).join("\n");
                logMessage("VFI ffmpeg failed (exit " + ret + "):", "error");
                if (tail) logMessage(tail, "error");
                await instance.deleteFile(inputName).catch(() => {});
                await instance.deleteFile(out).catch(() => {});
                progressBar.classList.remove("indeterminate");
                throw new Error("VFI ffmpeg failed with exit code " + ret);
            }
            const data = await instance.readFile(out);
            if (!data || data.length < 100) {
                logMessage("VFI produced empty or invalid output.", "error");
                await instance.deleteFile(inputName).catch(() => {});
                await instance.deleteFile(out).catch(() => {});
                progressBar.classList.remove("indeterminate");
                throw new Error("VFI produced no output");
            }
            if (!keepFile) {
                await instance.deleteFile(out).catch(() => {});
            }
            return data;
        };

        logMessage(
            "Interpolating video frames to 60fps... This may take up to a minute.",
            "info",
        );
        showProgress();
        progressBar.classList.add("indeterminate");

        const outputData = await runAndRead(
            buildArgs(buildFilter(), outputName, ["-c:a", "copy"]),
            outputName,
        );

        logMessage("Completed frame processing.", "success");
        const head = String.fromCharCode(...outputData.slice(4, 12));
        logMessage(`  VFI output: ${outputData.length} bytes, head="${head}"`, "info");

        await instance.deleteFile(inputName).catch(() => {});
        progressBar.classList.remove("indeterminate");

        return outputData.slice().buffer;
    } catch (err) {
        await destroyFFmpegInstance();
        throw err;
    }
}

async function extractMovThumbnailFFmpeg(file) {
    const { fetchFile } = await import("@ffmpeg/util");
    let instance;
    try {
        instance = await getFFmpeg();
        const ext = isMovFile(file) ? ".mov" : ".mp4";
        const inputName = `thumb_input${ext}`;
        await instance.writeFile(inputName, await fetchFile(file));
        await instance.exec([
            "-y",
            "-loglevel",
            "error",
            "-ss",
            "0.1",
            "-i",
            inputName,
            "-vframes",
            "1",
            "-f",
            "mjpeg",
            "thumb.jpg",
        ]);
        const data = await instance.readFile("thumb.jpg");
        await instance.deleteFile(inputName).catch(() => {});
        await instance.deleteFile("thumb.jpg").catch(() => {});
        if (data && data.length > 100) {
            const bytes = new Uint8Array(data.buffer, data.byteOffset, data.length);
            let binary = "";
            for (let j = 0; j < bytes.length; j++) {
                binary += String.fromCharCode(bytes[j]);
            }
            return `data:image/jpeg;base64,${btoa(binary)}`;
        }
    } catch (_) {
        return null;
    } finally {
        await destroyFFmpegInstance();
    }
    return null;
}
async function patchSingleFile(item) {
    const resolutionEl = document.getElementById("outputResolution");
    const targetRes = resolutionEl
        ? Number.parseInt(resolutionEl.value, 10)
        : 1080;

    let sourceBuffer = null;
    let movThumbnail = null;
    let videoInfo = null;

    if (isMovFile(item.file) && !enableInterpolation?.checked) {
        logMessage("Processing MOV file directly...", "info");
        try {
            movThumbnail = await captureVideoFrame(item.file);
        } catch (_) {
            movThumbnail = null;
        }
        if (isCancelled) throw new Error("Cancelled");
    }

    if (enableInterpolation?.checked) {
        const fileBytes = new Uint8Array(await item.file.arrayBuffer());
        const fileView = new DataView(fileBytes.buffer);
        const dims = getDimensionsFromMp4Container(fileBytes, fileView);
        const topBoxes = parseBoxes(fileBytes, fileView, 0, fileBytes.length);
        const moovBox = topBoxes.find((b) => b.type === "moov");
        let codec = null;
        if (moovBox) {
            codec = detectVideoCodecFromMoov(fileBytes, fileView, moovBox);
        }

        if (!dims) {
            throw new Error("Could not parse video dimensions from container.");
        }

        if (codec === "hvc1" || codec === "hev1") {
            const container = isMovFile(item.file) ? "MOV" : "MP4";
            logMessage(
                `HEVC ${container} (${codec}) detected - using multi-thread VFI engine.`,
                "info"
            );
        } else {
            logMessage(
                "Starting VFI Engine for 60fps interpolation...",
                "info",
            );
        }
        if (isCancelled) throw new Error("Cancelled");

        videoInfo = await getVideoDurationAndResolution(item.file);
        if (isCancelled) throw new Error("Cancelled");

        const workingBuffer = await runVFI(
            item.file,
            dims.width,
            dims.height,
            targetRes,
        );
        sourceBuffer = workingBuffer;
        logMessage(
            "VFI interpolation complete. Proceeding to binary patch pipeline...",
            "success",
        );

        await destroyFFmpegInstance();
        logMessage("VFI engine reset for binary patch pipeline...", "info");

        if (codec === "hvc1" || codec === "hev1") {
            try {
                movThumbnail = await extractMovThumbnailFFmpeg(item.file);
            } catch (_) {
                movThumbnail = null;
            }
        }

    }
    if (isCancelled) throw new Error("Cancelled");

    if (!sourceBuffer) {
        videoInfo = await getVideoDurationAndResolution(item.file);
        if (isCancelled) throw new Error("Cancelled");
        if (!videoInfo && !isMovFile(item.file)) {
            throw new Error("Could not parse video metadata.");
        }
    } else if (!videoInfo) {
        videoInfo = await getVideoDurationAndResolution(item.file);
    }

    const mimeType = getMimeType(item.file);
    const outputName = getOutputFilename(item.file);

    let inputBytes;
    let inputView;

    if (sourceBuffer) {
        inputBytes = new Uint8Array(sourceBuffer);
        inputView = new DataView(sourceBuffer);
        logMessage("  Source: VFI 60fps output", "info");
    } else {
        inputBytes = new Uint8Array(await item.file.arrayBuffer());
        inputView = new DataView(inputBytes.buffer);
        if (videoInfo) {
            logMessage(
                `  Source: ${videoInfo.width}x${videoInfo.height} (${
                    videoInfo.width > videoInfo.height
                        ? "landscape"
                        : "portrait"
                })`,
                "info",
            );
        } else {
            logMessage(
                "  Source: MOV file (dimensions from container)",
                "info",
            );
        }
    }

    logMessage("  Normalizing container...", "info");
    const normalized = normalizeContainer(inputBytes, inputView);
    let finalBuffer = normalized.newBuffer;
    let finalBytes = normalized.newBytes;
    let finalView = normalized.newView;

    if (normalized.changed) {
        logMessage("  Container normalized.", "success");
    } else if (!normalized.valid) {
        throw new Error("Invalid container: moov box not found");
    } else {
        logMessage("  Container already normalized.", "info");
    }

    const inflateResult = inflateSampleTableVideo(finalBytes, finalView, 10);
    finalBuffer = inflateResult.newBuffer;
    finalBytes = inflateResult.newBytes;
    finalView = new DataView(finalBuffer);
    logMessage("  Frame Density Inflation: Applied.", "success");

    return {
        finalBuffer,
        outputName,
        mimeType,
        prePatchBuffer: sourceBuffer,
        movThumbnail,
    };
}

async function downloadSelectedFiles() {
    const selectedToDownload = selectedFiles.filter(
        (f) => f.status === "success" && f.checked && f.patchedBuffer,
    );
    if (selectedToDownload.length === 0) return;

    logMessage(
        `Starting download for ${selectedToDownload.length} file(s)...`,
        "info",
    );

    for (let i = 0; i < selectedToDownload.length; i++) {
        const item = selectedToDownload[i];
        logMessage(`  Downloading: ${item.outputName}`, "success");
        downloadBuffer(item.patchedBuffer, item.outputName, item.mimeType);
        item.patchedBuffer = null;
        item.file = null;
        item.checked = false;

        if (i < selectedToDownload.length - 1) {
            await new Promise((r) => setTimeout(r, DOWNLOAD_INTERVAL_MS));
        }
    }

    logMessage("All selected downloads triggered successfully.", "success");
    renderFileList();
    updatePatchButton();
}

dropZone.addEventListener("click", () => {
    fileInput.click();
});

fileInput.addEventListener("change", (event) => {
    if (event.target.files.length > 0) addFiles(event.target.files);
    fileInput.value = "";
});

clearBtn.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (currentFlowState === "patching") {
        isCancelled = true;
        logMessage("Cancelling active interpolation progress...", "warning");
        await destroyFFmpegInstance();
        return;
    }
    selectedFiles = [];
    currentFlowState = "idle";
    setLogCopyVisible(false);
    hideProgress();
    clearLog();
    renderFileList();
    updatePatchButton();
});

dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("drag-over");
});

dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("drag-over");
});

dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("drag-over");
    if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
});

let wakeLock = null;

async function acquireWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => {
            if (currentFlowState === "patching") {
                acquireWakeLock();
            }
        });
    } catch (_) {
        wakeLock = null;
    }
}

function releaseWakeLock() {
    if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
    }
}

document.addEventListener("visibilitychange", () => {
    if (
        document.visibilityState === "visible" &&
        currentFlowState === "patching" &&
        !wakeLock
    ) {
        acquireWakeLock();
    }
});

patchBtn.addEventListener("click", async () => {
    if (!requireActiveSubscription()) return;
    const failedItems = selectedFiles.filter((f) => f.status === "error");
    if (failedItems.length > 0) {
        for (const item of failedItems) {
            item.status = "pending";
            item.checked = true;
            item.patchedBuffer = null;
        }
        currentFlowState = "idle";
        setLogCopyVisible(false);
        renderFileList();
        updatePatchButton();
    }

    if (currentFlowState === "completed") {
        const currentVfi = !!enableInterpolation?.checked;
        const currentRes =
            document.getElementById("outputResolution")?.value || "1080";
        const settingsChanged =
            currentVfi !== lastPatchedVfi || currentRes !== lastPatchedRes;

        if (settingsChanged) {
            for (const item of selectedFiles) {
                if (item.status === "success" || item.status === "error") {
                    item.status = "pending";
                    item.checked = true;
                    item.patchedBuffer = null;
                }
            }
            currentFlowState = "idle";
            setLogCopyVisible(false);
            renderFileList();
            updatePatchButton();
        } else {
            const checkedCount = selectedFiles.filter(
                (f) =>
                    f.status === "success" && f.checked && f.patchedBuffer,
            ).length;
            if (checkedCount > 0) {
                await downloadSelectedFiles();
                return;
            }
        }
    }

    const pendingItems = selectedFiles.filter((f) => f.status === "pending");
    if (pendingItems.length === 0) return;

    currentFlowState = "patching";
    lastPatchedVfi = !!enableInterpolation?.checked;
    lastPatchedRes =
        document.getElementById("outputResolution")?.value || "1080";
    setLogCopyVisible(false);
    clearLog();
    patchBtn.disabled = true;
    clearBtn.innerText = "Cancel";
    clearBtn.disabled = false;
    showProgress();
    await acquireWakeLock();

    isCancelled = false;
    let successCount = 0;

    for (let i = 0; i < pendingItems.length; i++) {
        if (isCancelled) {
            break;
        }
        const item = pendingItems[i];
        setProgress(Math.round((i / pendingItems.length) * 100));

        item.status = "processing";
        renderFileList();
        logMessage(`[${i + 1}/${pendingItems.length}] ${item.name}`, "info");

        try {
            const result = await patchSingleFile(item);
            if (isCancelled) {
                item.status = "pending";
                break;
            }
            item.status = "success";
            item.patchedBuffer = result.finalBuffer;
            item.outputName = result.outputName;
            item.mimeType = result.mimeType;
            item.checked = true;
            successCount++;

            if (
                item.status === "success" &&
                result.finalBuffer &&
                result.finalBuffer.byteLength !== undefined
            ) {
                try {
                    if (isCancelled) break;
                    const blob = new Blob([result.finalBuffer], {
                        type: result.mimeType,
                    });

                    let thumbnail = null;
                    if (result.movThumbnail) {
                        thumbnail = result.movThumbnail;
                        logMessage(
                            "Thumbnail captured from MOV extraction",
                            "info",
                        );
                    }
                    if (!thumbnail) {
                        try {
                            thumbnail = await captureVideoFrame(blob);
                            if (thumbnail) {
                                logMessage(
                                    "Thumbnail captured from output",
                                    "info",
                                );
                            }
                        } catch (_) {
                            // HEVC output can't be decoded by browser
                        }
                    }
                    if (!thumbnail && !isMovFile(item.file)) {
                        thumbnail = await captureVideoFrame(item.file);
                        if (thumbnail) {
                            logMessage(
                                "Thumbnail captured from original file",
                                "info",
                            );
                        }
                    }
                    if (isCancelled) break;

                    if (!thumbnail) {
                        logMessage(
                            "Warning: No thumbnail available for history entry",
                            "warning",
                        );
                    }
                    await saveRecord({
                        id: self.crypto.randomUUID(),
                        name: result.outputName,
                        size: result.finalBuffer.byteLength,
                        timestamp: Date.now(),
                        thumbnail,
                        blob,
                        mimeType: result.mimeType,
                    });
                    await renderHistoryList();
                } catch (dbError) {
                    logMessage(
                        `  Database save skipped: ${dbError.message}`,
                        "warning",
                    );
                }
            }

            if (i < pendingItems.length - 1) {
                if (isCancelled) {
                    break;
                }
                await new Promise((r) => setTimeout(r, PATCH_INTERVAL_MS));
                if (isCancelled) {
                    break;
                }
            }
        } catch (error) {
            if (isCancelled) {
                item.status = "pending";
                break;
            }
            item.status = "error";
            item.checked = false;
            const msg =
                error instanceof Error
                    ? error.message
                    : String(error);
            logMessage(`  Error: ${msg}`, "error");
        }

        renderFileList();
    }

    if (isCancelled) {
        for (const item of pendingItems) {
            if (item.status === "processing" || item.status === "pending") {
                item.status = "pending";
            }
        }
        currentFlowState = "idle";
        setProgress(0);
        hideProgress();
        releaseWakeLock();
        setLogCopyVisible(false);
        clearBtn.innerText = "Clear";
        logMessage("Interpolation progress cancelled by user.", "warning");
        renderFileList();
        updatePatchButton();
        // Remix Icon CSS handles rendering
        return;
    }

    currentFlowState =
        successCount === pendingItems.length ? "completed" : "idle";
    setProgress(100);
    releaseWakeLock();
    setLogCopyVisible(true);
    logMessage(
        `Done. ${successCount}/${pendingItems.length} file(s) patched successfully.`,
        successCount === pendingItems.length ? "success" : "warning",
    );
    hideProgress();

    clearBtn.innerText = "Clear";
    clearBtn.disabled = false;
    renderFileList();
    updatePatchButton();
    // Remix Icon CSS handles rendering
});

async function renderHistoryList() {
    const records = await getAllRecords();
    historyList.innerHTML = "";
    historyBadge.textContent = records.length;
    const navHistoryCount = document.getElementById("navHistoryCount");
    if (navHistoryCount) {
        navHistoryCount.textContent = String(records.length);
        navHistoryCount.hidden = records.length === 0;
    }

    if (records.length === 0) {
        historyList.innerHTML = `<div class="history-item-empty">No history records found</div>`;
        // Remix Icon CSS handles rendering
        return;
    }

    for (const record of records) {
        const item = document.createElement("div");
        item.className = "history-item";

        const thumb = document.createElement("div");
        thumb.className = "history-thumbnail";
        if (record.thumbnail?.startsWith(SAFE_THUMBNAIL_PREFIX)) {
            const img = document.createElement("img");
            img.src = record.thumbnail;
            img.alt = "preview";
            thumb.appendChild(img);
        } else {
            const icon = document.createElement("i");
            icon.className = "ri-movie-2-fill";
            thumb.appendChild(icon);
        }

        const body = document.createElement("div");
        body.className = "history-item-body";

        const name = document.createElement("div");
        name.className = "history-item-name";
        name.textContent = record.name;

        const meta = document.createElement("div");
        meta.className = "history-item-meta";
        meta.textContent = `${formatFileSize(record.size)} • ${new Date(
            record.timestamp,
        ).toLocaleTimeString()}`;

        body.appendChild(name);
        body.appendChild(meta);

        const actions = document.createElement("div");
        actions.className = "history-item-actions";

        const dlBtn = document.createElement("button");
        dlBtn.className = "history-btn";
        const dlIcon = document.createElement("i");
        dlIcon.className = "ri-download-fill";
        dlBtn.appendChild(dlIcon);
        dlBtn.addEventListener("click", () => {
            downloadBuffer(
                record.blob || record.buffer,
                record.name,
                record.mimeType || "video/mp4",
            );
        });

        const delBtn = document.createElement("button");
        delBtn.className = "history-btn history-btn-delete";
        const delIcon = document.createElement("i");
        delIcon.className = "ri-delete-bin-fill";
        delBtn.appendChild(delIcon);
        delBtn.addEventListener("click", async () => {
            await deleteRecord(record.id);
            await renderHistoryList();
        });

        actions.appendChild(dlBtn);
        actions.appendChild(delBtn);

        item.appendChild(thumb);
        item.appendChild(body);
        item.appendChild(actions);

        historyList.appendChild(item);
    }
    // Remix Icon CSS handles rendering
}

historyHeader.addEventListener("click", () => {
    const container = historyHeader.parentElement;
    container.classList.toggle("collapsed");
    const expanded = !container.classList.contains("collapsed");
    document.getElementById("historyToggleBtn")?.setAttribute(
        "aria-expanded",
        String(expanded),
    );
});

clearHistoryBtn.addEventListener("click", async () => {
    await clearAllRecords();
    await renderHistoryList();
});

let scrollPosition = 0;

function lockScroll() {
    scrollPosition = window.pageYOffset;
    document.body.style.overflow = "hidden";
    document.body.style.top = `-${scrollPosition}px`;
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
}

function unlockScroll() {
    document.body.style.overflow = "";
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    window.scrollTo(0, scrollPosition);
}

const enableInterpolation = document.getElementById("enableInterpolation");
const vfiModal = document.getElementById("vfiModal");
const closeVfiModalBtn = document.getElementById("closeVfiModalBtn");
const cancelVfiBtn = document.getElementById("cancelVfiBtn");
const confirmVfiBtn = document.getElementById("confirmVfiBtn");

if (enableInterpolation && vfiModal) {
    const resolutionBox = document.getElementById("vfiResolutionBox");

    enableInterpolation.addEventListener("change", () => {
        if (enableInterpolation.checked) {
            vfiModal.classList.add("active");
            lockScroll();
        }
        if (resolutionBox) {
            resolutionBox.style.display = enableInterpolation.checked
                ? "block"
                : "none";
        }
        updatePatchButton();
    });

    const outputResolution = document.getElementById("outputResolution");
    if (outputResolution) {
        outputResolution.addEventListener("change", () => {
            updatePatchButton();
        });
    }

    const closeModal = () => {
        vfiModal.classList.remove("active");
        unlockScroll();
        if (resolutionBox) {
            resolutionBox.style.display = enableInterpolation.checked
                ? "block"
                : "none";
        }
    };

    const cancelModal = () => {
        enableInterpolation.checked = false;
        closeModal();
    };

    closeVfiModalBtn?.addEventListener("click", cancelModal);
    cancelVfiBtn?.addEventListener("click", cancelModal);
    confirmVfiBtn?.addEventListener("click", closeModal);

    vfiModal.addEventListener("click", (e) => {
        if (e.target === vfiModal) cancelModal();
    });
}

const tiktokModal = document.getElementById("tiktokModal");
const tiktokStudioBtn = document.getElementById("tiktokStudioBtn");
const closeTiktokModalBtn = document.getElementById("closeTiktokModalBtn");
const cancelTiktokModalBtn = document.getElementById("cancelTiktokModalBtn");
const confirmTiktokBtn = document.getElementById("confirmTiktokBtn");

function isMobileDevice() {
    return (
        window.innerWidth <= MOBILE_BREAKPOINT ||
        /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
    );
}

if (tiktokStudioBtn && tiktokModal) {
    tiktokStudioBtn.addEventListener("click", (e) => {
        if (isMobileDevice()) {
            e.preventDefault();
            tiktokModal.classList.add("active");
            lockScroll();
        }
    });

    const closeTiktokModal = () => {
        tiktokModal.classList.remove("active");
        unlockScroll();
    };

    closeTiktokModalBtn?.addEventListener("click", closeTiktokModal);
    cancelTiktokModalBtn?.addEventListener("click", closeTiktokModal);
    confirmTiktokBtn?.addEventListener("click", closeTiktokModal);

    tiktokModal.addEventListener("click", (e) => {
        if (e.target === tiktokModal) closeTiktokModal();
    });
}

initializeApp();

const changelogContainer = document.getElementById("changelogContainer");
if (changelogContainer) {
    initChangelog(changelogContainer);
}
