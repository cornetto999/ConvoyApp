import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isAuthError } from "@supabase/supabase-js";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import MapExamplesSection from "@/components/MapExamplesSection";
import {
  GEOLOCATION_PERMISSION_DENIED,
  GEOLOCATION_POSITION_UNAVAILABLE,
  GEOLOCATION_TIMEOUT,
  INITIAL_POSITION_OPTIONS,
  getGeolocationErrorMessage,
  getGeolocationUnsupportedMessage,
  requestCurrentPosition,
  saveLastKnownLocation,
} from "@/lib/geolocation";
import { toast } from "sonner";
import { Navigation, Route, Users, Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Eye, EyeOff } from "lucide-react";

const LOCATION_PROMPT_SEEN_KEY = "convoy.location_prompt_seen";
const RESEND_COOLDOWN_MS = 60_000;
type AuthMode = "sign-in" | "sign-up" | "resend";

function getAuthFormError(error: unknown, mode: AuthMode) {
  const code = isAuthError(error) ? error.code : undefined;
  const message = error instanceof Error ? error.message : "";

  switch (code) {
    case "email_not_confirmed":
      return "Verify your email before signing in. You can request a new link below.";
    case "email_address_not_authorized":
      return "This email can't receive a verification link right now. The app's email service is limited to approved test addresses.";
    case "over_email_send_rate_limit":
      return "The email sending limit was reached. Wait before requesting another link.";
    case "over_request_rate_limit":
      return "Too many requests. Wait a moment before trying again.";
  }

  if (/error sending .*email/i.test(message)) {
    return "The email service couldn't send a verification link. Try again later.";
  }

  if (mode === "resend") return "Couldn't request a new verification link. Try again.";
  return message || "Authentication failed. Try again.";
}

export default function Auth() {
  const [mode, setMode] = useState<AuthMode>("sign-in");
  const isLogin = mode === "sign-in";
  const isResend = mode === "resend";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [locationPromptOpen, setLocationPromptOpen] = useState(false);
  const [locationPromptMessage, setLocationPromptMessage] = useState<string | null>(null);
  const [verificationEmail, setVerificationEmail] = useState<string | null>(null);
  const [resendCooldownEmail, setResendCooldownEmail] = useState<string | null>(null);
  const [resendRequested, setResendRequested] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [requestingLocation, setRequestingLocation] = useState(false);
  const { signIn, signUp, resendVerification, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const resendCoolingDown = resendCooldownEmail === email.trim().toLowerCase();

  const markLocationPromptSeen = () => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LOCATION_PROMPT_SEEN_KEY, "1");
  };

  const finishAuth = async () => {
    if (typeof window === "undefined") {
      navigateToApp();
      return;
    }

    if (window.localStorage.getItem(LOCATION_PROMPT_SEEN_KEY) === "1") {
      navigateToApp();
      return;
    }

    if (!("geolocation" in navigator)) {
      navigateToApp();
      return;
    }

    try {
      if ("permissions" in navigator && navigator.permissions?.query) {
        const permissionStatus = await navigator.permissions.query({
          name: "geolocation" as PermissionName,
        });

        if (permissionStatus.state !== "prompt") {
          navigateToApp();
          return;
        }
      }
    } catch {
      // Fall back to showing the prompt once when permission state can't be inspected.
    }

    setLocationPromptMessage(null);
    setLocationPromptOpen(true);
  };

  const navigateToApp = () => {
    setLocationPromptMessage(null);
    setLocationPromptOpen(false);
    navigate("/");
  };

  const handleSkipLocationPrompt = () => {
    markLocationPromptSeen();
    navigateToApp();
  };

  const handleEnableLocation = async () => {
    if (!("geolocation" in navigator)) {
      markLocationPromptSeen();
      toast.error(getGeolocationUnsupportedMessage("auth"));
      navigateToApp();
      return;
    }

    setLocationPromptMessage(null);
    setRequestingLocation(true);

    try {
      const position = await requestCurrentPosition(INITIAL_POSITION_OPTIONS);
      saveLastKnownLocation({
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        heading:
          typeof position.coords.heading === "number" && !Number.isNaN(position.coords.heading)
            ? position.coords.heading
            : 0,
        speed:
          typeof position.coords.speed === "number" && !Number.isNaN(position.coords.speed) && position.coords.speed > 0
            ? position.coords.speed * 3.6
            : 0,
        updatedAt: Date.now(),
      });
      markLocationPromptSeen();
      toast.success("Location enabled.");
      navigateToApp();
    } catch (error) {
      const locationRequestError = error as { code?: number; message?: string | null };
      const message = getGeolocationErrorMessage(locationRequestError, "auth");
      setLocationPromptMessage(message);

      if (locationRequestError.code === GEOLOCATION_PERMISSION_DENIED) {
        markLocationPromptSeen();
        toast.error(message);
        navigateToApp();
        return;
      }

      if (
        locationRequestError.code === GEOLOCATION_POSITION_UNAVAILABLE ||
        locationRequestError.code === GEOLOCATION_TIMEOUT
      ) {
        markLocationPromptSeen();
        toast.message("Location access is on. Convoy will keep trying while your GPS gets a fix.");
        navigateToApp();
        return;
      }

      toast.error(message);
    } finally {
      setRequestingLocation(false);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("verified") !== "1") return;

    const fragment = new URLSearchParams(location.hash.slice(1));
    const errorCode = params.get("error_code") ?? fragment.get("error_code");
    if (errorCode || params.has("error") || fragment.has("error")) {
      setMode("resend");
      setAuthError(errorCode === "otp_expired"
        ? "That verification link has expired. Request a new one."
        : "That verification link couldn't be used. Request a new one.");
      navigate("/login", { replace: true });
    } else if (user?.email_confirmed_at) {
      navigate("/", { replace: true });
    }
  }, [location.hash, location.search, navigate, user?.email_confirmed_at]);

  useEffect(() => {
    if (!resendCooldownEmail) return;
    const timeout = window.setTimeout(() => setResendCooldownEmail(null), RESEND_COOLDOWN_MS);
    return () => window.clearTimeout(timeout);
  }, [resendCooldownEmail]);

  const switchMode = (nextMode: AuthMode) => {
    setAuthError(null);
    setResendRequested(false);
    setPassword("");
    setShowPassword(false);
    setMode(nextMode);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting || (isResend && resendCoolingDown)) return;
    const address = email.trim();
    setAuthError(null);
    setSubmitting(true);
    try {
      if (isResend) {
        setResendRequested(false);
        await resendVerification(address);
        setResendCooldownEmail(address.toLowerCase());
        setResendRequested(true);
      } else if (isLogin) {
        await signIn(address, password);
        setVerificationEmail(null);
        toast.success("Welcome back!");
        await finishAuth();
      } else {
        const result = await signUp(address, password, displayName);
        if (result.requiresEmailVerification) {
          switchMode("sign-in");
          setVerificationEmail(result.email);
          return;
        }

        toast.success("Account created!");
        await finishAuth();
      }
    } catch (error) {
      setAuthError(getAuthFormError(error, mode));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleLogin = async () => {
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: `${window.location.origin}/~oauth/complete` },
    });
    if (error) toast.error(error.message || "Google sign-in failed");
    setSubmitting(false);
  };

  const handleAppleLogin = async () => {
    setSubmitting(true);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "apple",
      options: { redirectTo: `${window.location.origin}/~oauth/complete` },
    });
    if (error) toast.error(error.message || "Apple sign-in failed");
    setSubmitting(false);
  };

  return (
    <div className="min-h-screen bg-background p-4">
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-8 py-8">
        <div className="w-full max-w-md space-y-8">
          {/* Logo */}
          <div className="text-center space-y-2">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-primary/10 mb-4">
              <Navigation className="w-8 h-8 text-primary" />
            </div>
            <h1 className="text-3xl font-bold tracking-tight">Convoy</h1>
            <p className="text-muted-foreground">Navigate together, arrive together</p>
          </div>

          <Card className="border-border/50 shadow-lg">
            <CardHeader className="space-y-1 pb-4">
              <CardTitle className="text-xl">
                {isResend ? "Resend verification email" : isLogin ? "Sign in" : "Create account"}
              </CardTitle>
              <CardDescription>
                {isResend
                  ? "Enter the email address you used to create your account."
                  : isLogin
                    ? "Enter your credentials to access your convoys"
                    : "Set up your profile and verify your email to sign in."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {!isResend && (
                <div className="space-y-4">
                  {/* Social logins */}
                  <div className="grid grid-cols-2 gap-3">
                    <Button
                      variant="outline"
                      className="gap-2"
                      onClick={handleGoogleLogin}
                      disabled={submitting}
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24">
                        <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                        <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                        <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                        <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                      </svg>
                      Google
                    </Button>
                    <Button
                      variant="outline"
                      className="gap-2"
                      onClick={handleAppleLogin}
                      disabled={submitting}
                    >
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
                      </svg>
                      Apple
                    </Button>
                  </div>

                  <div className="relative">
                    <div className="absolute inset-0 flex items-center">
                      <Separator className="w-full" />
                    </div>
                    <div className="relative flex justify-center text-xs uppercase">
                      <span className="bg-card px-2 text-muted-foreground">or continue with email</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Email form */}
              <form onSubmit={handleSubmit} className="space-y-4">
                {mode === "sign-up" && (
                  <div className="space-y-2">
                    <Label htmlFor="displayName">Display Name</Label>
                    <Input
                      id="displayName"
                      placeholder="Road Warrior"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      required
                      disabled={submitting}
                    />
                  </div>
                )}
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="driver@convoy.app"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      setAuthError(null);
                      setResendRequested(false);
                    }}
                    autoComplete="email"
                    disabled={submitting}
                    required
                  />
                </div>
                {!isResend && (
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        placeholder="••••••••"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete={isLogin ? "current-password" : "new-password"}
                        disabled={submitting}
                        required
                        minLength={6}
                        className="pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
                        aria-label={showPassword ? "Hide password" : "Show password"}
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>
                )}
                {authError && <p role="alert" className="text-sm text-destructive">{authError}</p>}
                {isResend && resendRequested && (
                  <p role="status" className="text-sm text-muted-foreground">
                    If this address has an unverified account, look for a new link in your inbox or spam folder.
                  </p>
                )}
                <Button type="submit" className="w-full" disabled={submitting || (isResend && resendCoolingDown)}>
                  {isResend
                    ? submitting ? "Requesting link..." : resendCoolingDown ? "Try again in a minute" : "Request verification link"
                    : submitting ? "Loading..." : isLogin ? "Sign In" : "Create Account"}
                </Button>
              </form>

              {isLogin && verificationEmail?.toLowerCase() === email.trim().toLowerCase() && (
                <div role="status" className="rounded-lg border border-primary/20 bg-primary/5 px-4 py-3 text-sm">
                  <p className="font-medium text-foreground">Verify your email first</p>
                  <p className="mt-1 text-muted-foreground">
                    Check the inbox and spam folder for <span className="font-medium text-foreground">{verificationEmail}</span>.
                    Open the verification link, then sign in here.
                  </p>
                </div>
              )}
              <div className="flex flex-col items-center gap-3 text-center">
                {isLogin && (
                  <button
                    type="button"
                    className="text-sm font-medium text-primary hover:underline"
                    disabled={submitting}
                    onClick={() => switchMode("resend")}
                  >
                    Resend verification email
                  </button>
                )}
                <button
                  type="button"
                  className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  disabled={submitting}
                  onClick={() => switchMode(isLogin ? "sign-up" : "sign-in")}
                >
                  {isLogin
                    ? "Don't have an account? Sign up"
                    : isResend
                      ? "Back to sign in"
                      : "Already have an account? Sign in"}
                </button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="w-full space-y-6">
          <div className="grid gap-6 pt-2 sm:grid-cols-3">
            <div className="space-y-2 text-center">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
                <Route className="w-6 h-6 text-primary" />
              </div>
              <h3 className="font-semibold">Shared Routes</h3>
              <p className="text-sm text-muted-foreground">
                Leader sets the destination, everyone follows the same route
              </p>
            </div>
            <div className="space-y-2 text-center">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-accent/10">
                <Users className="w-6 h-6 text-accent" />
              </div>
              <h3 className="font-semibold">Live Tracking</h3>
              <p className="text-sm text-muted-foreground">
                See every member&apos;s position, speed, and status in real time
              </p>
            </div>
            <div className="space-y-2 text-center">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10">
                <Zap className="w-6 h-6 text-destructive" />
              </div>
              <h3 className="font-semibold">Smart Alerts</h3>
              <p className="text-sm text-muted-foreground">
                Off-route warnings, regroup calls, and gap alerts keep everyone safe
              </p>
            </div>
          </div>

          <MapExamplesSection />
        </div>
      </div>

      <AlertDialog open={locationPromptOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn on location?</AlertDialogTitle>
            <AlertDialogDescription>
              Location helps Convoy show your live position, speed, and regroup alerts once you join a trip.
            </AlertDialogDescription>
            {locationPromptMessage && (
              <p className="text-sm text-amber-600">{locationPromptMessage}</p>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleSkipLocationPrompt} disabled={requestingLocation}>
              Maybe later
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleEnableLocation()} disabled={requestingLocation}>
              {requestingLocation ? "Enabling..." : "Turn on location"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
