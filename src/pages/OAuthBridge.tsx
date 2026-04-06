import { useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { Navigation } from "lucide-react";

// Handles external OAuth callback/initiation paths used by hosted auth flows.
// We simply bounce the user back to the auth page (or home if already signed in).
export default function OAuthBridge() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    // Preserve any query string the provider might include
    const search = location.search || "";
    navigate(`/login${search}`, { replace: true });
  }, [navigate, location.search]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex items-center gap-3 text-muted-foreground">
        <Navigation className="w-5 h-5 animate-spin text-primary" />
        <span>Redirecting…</span>
      </div>
    </div>
  );
}
