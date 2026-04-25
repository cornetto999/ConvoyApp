import LocationSharingClient from "../../../components/location-sharing-client";

export default function TrackUserPage({ params }) {
  return (
    <LocationSharingClient
      mode="viewer"
      trackedUserId={decodeURIComponent(params.user_id)}
    />
  );
}
