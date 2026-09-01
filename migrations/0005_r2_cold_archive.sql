-- 浏览器先按数据集和时间范围定位小时对象，避免为冷归档索引扫描全部 manifest。
CREATE INDEX archive_manifests_dataset_time_idx
ON archive_manifests(dataset, range_start DESC, zone_id);
