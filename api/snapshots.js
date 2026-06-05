// 業務委託スナップショット（contractor_snapshots）API。
import { handleSnapshotTable } from './_lib/snapshots.js';
export default (req, res) => handleSnapshotTable(req, res, 'contractor_snapshots');
