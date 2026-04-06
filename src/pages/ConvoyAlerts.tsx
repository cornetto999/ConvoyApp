import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ArrowLeft, Bell, AlertTriangle, Radio, MapPin, GitBranch, Check } from "lucide-react";
import type { ConvoyAlert, Profile } from "@/types/convoy";

type AlertWithCreator = ConvoyAlert & { creator_profile?: Profile | null };

export default function ConvoyAlerts() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [alerts, setAlerts] = useState<AlertWithCreator[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id || !user) return;
    loadAlerts();

    const channel = supabase
      .channel(`convoy-alerts-${id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "convoy_alerts", filter: `convoy_id=eq.${id}` },
        () => loadAlerts()
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [id, user]);

  const loadAlerts = async () => {
    const { data } = await supabase
      .from("convoy_alerts")
      .select("*")
      .eq("convoy_id", id!)
      .order("created_at", { ascending: false });

    if (data) {
      // Enrich with creator profiles
      const creatorIds = [...new Set(data.map((a) => a.created_by))];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("*")
        .in("user_id", creatorIds);

      const enriched = data.map((alert) => ({
        ...alert,
        creator_profile: profiles?.find((p) => p.user_id === alert.created_by) || null,
      }));
      setAlerts(enriched);
    }
    setLoading(false);
  };

  const handleAcknowledge = async (alertId: string) => {
    const { error } = await supabase
      .from("convoy_alerts")
      .update({ acknowledged: true })
      .eq("id", alertId);
    if (error) toast.error("Failed to acknowledge");
    else toast.success("Alert acknowledged");
  };

  const alertIcon = (type: string) => {
    switch (type) {
      case "regroup": return <Radio className="w-4 h-4 text-destructive" />;
      case "off_route": return <GitBranch className="w-4 h-4 text-accent" />;
      case "hazard": return <AlertTriangle className="w-4 h-4 text-destructive" />;
      case "gap": return <MapPin className="w-4 h-4 text-accent" />;
      default: return <Bell className="w-4 h-4" />;
    }
  };

  const alertColor = (type: string) => {
    switch (type) {
      case "regroup": return "border-destructive/30 bg-destructive/5";
      case "hazard": return "border-destructive/30 bg-destructive/5";
      case "off_route": return "border-accent/30 bg-accent/5";
      case "gap": return "border-accent/30 bg-accent/5";
      default: return "";
    }
  };

  const formatTime = (ts: string) => {
    const d = new Date(ts);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return "Just now";
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return d.toLocaleDateString();
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 h-16 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(`/convoy/${id}`)}>
            <ArrowLeft className="w-5 h-5" />
          </Button>
          <div>
            <h1 className="font-bold text-lg">Alerts</h1>
            <p className="text-xs text-muted-foreground">{alerts.length} alert{alerts.length !== 1 ? "s" : ""}</p>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 space-y-3">
        {loading ? (
          <div className="text-center py-12 text-muted-foreground">Loading alerts...</div>
        ) : alerts.length === 0 ? (
          <div className="text-center py-12 space-y-3">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mx-auto">
              <Bell className="w-8 h-8 text-muted-foreground" />
            </div>
            <p className="text-muted-foreground">No alerts yet</p>
          </div>
        ) : (
          alerts.map((alert) => (
            <Card key={alert.id} className={`${alertColor(alert.type)} ${alert.acknowledged ? "opacity-60" : ""}`}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5">{alertIcon(alert.type)}</div>
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs capitalize">
                          {alert.type.replace("_", " ")}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {formatTime(alert.created_at)}
                        </span>
                      </div>
                      {alert.message && (
                        <p className="text-sm">{alert.message}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        by {alert.creator_profile?.display_name || "Unknown"}
                      </p>
                    </div>
                  </div>
                  {!alert.acknowledged && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleAcknowledge(alert.id)}
                      className="gap-1 shrink-0"
                    >
                      <Check className="w-3 h-3" />
                      Ack
                    </Button>
                  )}
                  {alert.acknowledged && (
                    <Badge variant="secondary" className="text-xs shrink-0">
                      <Check className="w-3 h-3 mr-1" />
                      Acked
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </main>
    </div>
  );
}
