import { Suspense } from "react";

import {
  StudyRoutePreview,
  StudyRoutePreviewFallback,
} from "../../components/study-route-preview";

export const dynamic = "force-static";

export default function StudyPage() {
  return (
    <Suspense fallback={<StudyRoutePreviewFallback />}>
      <StudyRoutePreview />
    </Suspense>
  );
}
