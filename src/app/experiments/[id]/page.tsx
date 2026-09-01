import { ExperimentResults } from "@/components/experiment-results";

export default async function ExperimentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ExperimentResults id={id} />;
}
