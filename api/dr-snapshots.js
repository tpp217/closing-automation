// DR スナップショット（dr_snapshots）API。
import { handleSnapshotTable } from './_lib/snapshots.js';
export default (req, res) => handleSnapshotTable(req, res, 'dr_snapshots');
