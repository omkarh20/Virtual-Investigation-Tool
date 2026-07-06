import numpy as np

# Total points: 4
# P0: outside both
# P1: in A only
# P2: in B only
# P3: in both A and B

in_A = np.array([False, True, False, True])
in_B = np.array([False, False, True, True])

keep_mask = np.ones(4, dtype=bool)

# Box A (Red)
to_delete_A = in_A
keep_mask = keep_mask & ~to_delete_A

# Box B (Red)
to_delete_B = in_B
keep_mask = keep_mask & ~to_delete_B

print("Keep mask:", keep_mask)
print("Deleted points (mask == False):", ~keep_mask)
