# Example: List Forma Hubs

**Prompt:**
```
List all the Autodesk Forma hubs my service account has access to.
```

**Expected tool call:**
```
dm_list_hubs()
```

**Sample output:**
```
Found 2 hub(s):

• Contoso Construction  (ID: b.abc-12345678)  [region: US]
• Contoso EMEA          (ID: b.def-87654321)  [region: EMEA]
```

**Next steps:** Use a hub ID with `dm_list_projects` or `admin_list_projects` to explore projects.
