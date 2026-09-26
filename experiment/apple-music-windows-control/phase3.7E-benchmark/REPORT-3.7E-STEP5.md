# Phase 3.7E step 5 - remove the unconditional 500 ms wait in Invoke-AmNavigateUrl

Single change: poc/lib/am-uia.ps1 line 245 Start-Sleep -Milliseconds 500 -> 0. No other edit.
baseline(4): bench-20260926-090320.jsonl   step5(5): bench-20260926-090905.jsonl

Measurement resolution (declared): requested 50 ms poll -> measured gap median 80 ms / mean 82 ms / max 121 ms.

| case | stage 4->5 | contentMatchMs 4->5 | t6_ms 4->5 | occupancy 4->5 | d_occ | d_t6 |
|---|---|---|---|---|---|---|
| B01 | OK->OK | 1093->2151 | 3074->4549 | 2527->4000 | 1473 | 1475 |
| B02 | SMTC_TIMEOUT->SMTC_TIMEOUT | 1822->2099 | 10027->10319 | 9012->9311 | 299 | 292 |
| B03 | OK->OK | 1489->1280 | 3378->3207 | 2944->2791 | -153 | -171 |
| B04 | SMTC_TIMEOUT->SMTC_TIMEOUT | 1837->1347 | 9952->9544 | 8957->8513 | -444 | -408 |
| B05 | OK->OK | 1966->1938 | 4017->3934 | 3587->3488 | -99 | -83 |
| B06 | OK->OK | 1813->2211 | 3821->4254 | 3459->3795 | 336 | 433 |
| B07 | OK->OK | 1491->1437 | 3599->3491 | 3239->3042 | -197 | -108 |
| B08 | OK->OK | 2502->2011 | 4433->4053 | 4103->3575 | -528 | -380 |
| B09 | OK->OK | 2161->1702 | 4355->3899 | 3919->3438 | -481 | -456 |
| B10 | OK->OK | 1401->1528 | 3528->4302 | 3024->3846 | 822 | 774 |
| B11 | OK->OK | 1807->2079 | 3915->4710 | 3422->4402 | 980 | 795 |
| B12 | OK->OK | 1976->1750 | 3969->3813 | 3565->3359 | -206 | -156 |
| B13 | TARGET_ROW_NOT_FOUND->TARGET_ROW_NOT_FOUND | 1703->1789 | 13461->13516 | 12421->12446 | 25 | 55 |
| B14 | OK->OK | 1442->1684 | 3581->3743 | 3199->3275 | 76 | 162 |
| B15 | OK->OK | 1903->1734 | 3969->3762 | 3532->3296 | -236 | -207 |
| B16 | OK->OK | 1750->2109 | 3834->4040 | 3358->3712 | 354 | 206 |
| B17 | OK->OK | 1942->1579 | 4450->3625 | 4060->3175 | -885 | -825 |
| B18 | OK->OK | 1534->1871 | 3665->3903 | 3241->3510 | 269 | 238 |
| B19 | OK->OK | 2189->1702 | 4244->3855 | 3756->3422 | -334 | -389 |
| B20 | OK->OK | 1963->1770 | 4022->3761 | 3601->3382 | -219 | -261 |

## S4
- contentMatchMs n=1 min=1963 p50=1963 p90=1963 max=1963
- t3_ms n=1 min=710 p50=710 p90=710 max=710
- t6_ms n=1 min=4022 p50=4022 p90=4022 max=4022
- t_smtc_ms n=1 min=4111 p50=4111 p90=4111 max=4111
- t10_ms n=1 min=4311 p50=4311 p90=4311 max=4311
- activation_to_click_upper_bound_ms n=1 min=3312 p50=3312 p90=3312 max=3312
- foreground_occupancy_ms n=1 min=3601 p50=3601 p90=3601 max=3601
- playingCorrect=1/ failures=[]
## S5
- contentMatchMs n=1 min=1770 p50=1770 p90=1770 max=1770
- t3_ms n=1 min=701 p50=701 p90=701 max=701
- t6_ms n=1 min=3761 p50=3761 p90=3761 max=3761
- t_smtc_ms n=1 min=3850 p50=3850 p90=3850 max=3850
- t10_ms n=1 min=4083 p50=4083 p90=4083 max=4083
- activation_to_click_upper_bound_ms n=1 min=3060 p50=3060 p90=3060 max=3060
- foreground_occupancy_ms n=1 min=3382 p50=3382 p90=3382 max=3382
- playingCorrect=1/ failures=[]

## Paired deltas (5 minus 4)
- occupancy delta all  n=20 min=-885 p50=-153 max=1473 mean=43
- occupancy delta success-only  n=17 min=-885 p50=-153 max=1473 mean=57