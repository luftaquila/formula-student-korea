export const ENDURANCE_SQL = {
  status: "UPDATE score_endurance SET status = ? WHERE year = ? AND team_num = ?",
  driver1_name: "UPDATE score_endurance SET driver1_name = ? WHERE year = ? AND team_num = ?",
  driver1_time: "UPDATE score_endurance SET driver1_time = ? WHERE year = ? AND team_num = ?",
  driver1_start_delay:
    "UPDATE score_endurance SET driver1_start_delay = ? WHERE year = ? AND team_num = ?",
  driver1_cones: "UPDATE score_endurance SET driver1_cones = ? WHERE year = ? AND team_num = ?",
  driver1_oc: "UPDATE score_endurance SET driver1_oc = ? WHERE year = ? AND team_num = ?",
  driver1_penalty: "UPDATE score_endurance SET driver1_penalty = ? WHERE year = ? AND team_num = ?",
  driver_change_time:
    "UPDATE score_endurance SET driver_change_time = ? WHERE year = ? AND team_num = ?",
  driver2_name: "UPDATE score_endurance SET driver2_name = ? WHERE year = ? AND team_num = ?",
  driver2_time: "UPDATE score_endurance SET driver2_time = ? WHERE year = ? AND team_num = ?",
  driver2_start_delay:
    "UPDATE score_endurance SET driver2_start_delay = ? WHERE year = ? AND team_num = ?",
  driver2_cones: "UPDATE score_endurance SET driver2_cones = ? WHERE year = ? AND team_num = ?",
  driver2_oc: "UPDATE score_endurance SET driver2_oc = ? WHERE year = ? AND team_num = ?",
  driver2_penalty: "UPDATE score_endurance SET driver2_penalty = ? WHERE year = ? AND team_num = ?",
  fuel_consumed: "UPDATE score_endurance SET fuel_consumed = ? WHERE year = ? AND team_num = ?",
  fuel_extra: "UPDATE score_endurance SET fuel_extra = ? WHERE year = ? AND team_num = ?",
  electric_net_energy:
    "UPDATE score_endurance SET electric_net_energy = ? WHERE year = ? AND team_num = ?",
  energy_dsq: "UPDATE score_endurance SET energy_dsq = ? WHERE year = ? AND team_num = ?",
  qualified: "UPDATE score_endurance SET qualified = ? WHERE year = ? AND team_num = ?",
};
