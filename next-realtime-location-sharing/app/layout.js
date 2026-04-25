import "leaflet/dist/leaflet.css";
import "./globals.css";

export const metadata = {
  title: "Realtime Location Sharing",
  description: "Google Maps or Grab style live location sharing with Next.js, Supabase, and Leaflet."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
