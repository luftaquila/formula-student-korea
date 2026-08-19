import { currentCompetitionYear } from "../../../shared/competition-year.mjs";
import { BASE_URL } from "./auth.mjs";

const teamRequests = new Map();

export async function trafficEntry(number, year = currentCompetitionYear()) {
  const key = `${year}:${number}`;
  if (!teamRequests.has(key)) teamRequests.set(key, loadTrafficEntry(number, year));
  return teamRequests.get(key);
}

async function loadTrafficEntry(number, year) {
  const response = await fetch(`${BASE_URL}/competition/api/v1/teams?year=${year}`);
  if (!response.ok) throw new Error(`Could not load Competition teams: ${response.status}`);
  const teams = await response.json();
  const team = teams.find((candidate) => candidate.number === number);
  if (!team) throw new Error(`Active Competition team ${number} was not found for ${year}`);
  return {
    id: team.id,
    num: team.number,
    univ: team.university,
    team: team.name,
  };
}
