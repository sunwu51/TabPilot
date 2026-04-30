/* global chrome */
import { Button, Card, Input } from "@sunwu51/camel-ui";
import { useState } from "react";
import toast from "react-hot-toast";

export default function Group() {
    let [groupRule, setGroupRule] = useState("");

    async function triggerGroup() {
        // 正则格式 可以是 google  谷歌#google，前者代表组名和正则都是google
        var m = groupRule.match(/^((.+)#)?(.+)$/)
        if (m) {
            var groupName = m[2] ? m[2] : m[3];
            var regex = new RegExp(m[3]);
            var tabs = await chrome.tabs.query({});
            tabs = tabs.filter(item => item.url && item.url.match(regex));
            if (tabs.length <= 0) {
                toast.error("没有符合条件的tabs")
                return
            }
            var groups = await chrome.tabGroups.query({ title: groupName });
            
            console.log({groupName, tabs, groups})
            // 已经存在同名group，则把所有的tab加入到已存在的group中
            var groupId;
            if (groups && groups.length) {
                groupId = groups[0].id;
                await chrome.tabs.group({ groupId, tabIds: tabs.map(it => it.id) });
            } else {
                groupId = await chrome.tabs.group({ tabIds: tabs.map(it => it.id) });
                await chrome.tabGroups.update(groupId, { title: groupName })
            }
            // await chrome.tabGroups.move(groupId, {index: 0, windowId: chrome.windows.WINDOW_ID_CURRENT});
        } else {
            toast.error("输入不合法~");
        }
    }


    const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'];

    async function autoGroupByDomain() {
        const tabs = await chrome.tabs.query({});
        const httpTabs = tabs.filter(t => t.url && t.url.startsWith("http"));
        // 按域名分组
        const domainMap = {};
        for (const tab of httpTabs) {
            try {
                const hostname = new URL(tab.url).hostname;
                if (!domainMap[hostname]) domainMap[hostname] = [];
                domainMap[hostname].push(tab.id);
            } catch (e) {/* ignore */}
        }
        // 只对有多个标签的域名创建分组
        let colorIdx = 0;
        let groupCount = 0;
        for (const [domain, tabIds] of Object.entries(domainMap)) {
            if (tabIds.length < 2) continue;
            // 检查是否已有同名分组
            const existing = await chrome.tabGroups.query({ title: domain });
            let groupId;
            if (existing && existing.length) {
                groupId = existing[0].id;
                await chrome.tabs.group({ groupId, tabIds });
            } else {
                groupId = await chrome.tabs.group({ tabIds });
                await chrome.tabGroups.update(groupId, {
                    title: domain,
                    color: GROUP_COLORS[colorIdx % GROUP_COLORS.length]
                });
                colorIdx++;
            }
            groupCount++;
        }
        if (groupCount > 0) {
            toast.success(`已按域名创建 ${groupCount} 个分组`);
        } else {
            toast("没有可分组的标签页（至少需要同域名 2 个以上）");
        }
    }

    async function collapseAllGroups() {
        const groups = await chrome.tabGroups.query({});
        for (const g of groups) {
            await chrome.tabGroups.update(g.id, { collapsed: true });
        }
        toast.success(`已折叠 ${groups.length} 个分组`);
    }

    async function ungroupAll() {
        const tabs = await chrome.tabs.query({});
        const groupedTabs = tabs.filter(t => t.groupId && t.groupId !== -1);
        if (groupedTabs.length === 0) {
            toast("没有已分组的标签页");
            return;
        }
        for (const tab of groupedTabs) {
            await chrome.tabs.ungroup(tab.id);
        }
        toast.success(`已取消 ${groupedTabs.length} 个标签的分组`);
    }

    return <>
        <Card>
            <span className="text-sm text-gray-500 font-bold block mb-1">分组</span>
            <div className="flex gap-1 mb-2">
                <Input
                    aria-label="分组规则"
                    inputClassName="!min-h-8 flex-1"
                    onChange={setGroupRule}
                    placeholder="分组名#url正则"
                />
                <Button className="!text-xs !whitespace-nowrap flex-shrink-0" onPress={triggerGroup}>分组</Button>
            </div>
            <div className="flex gap-1 items-center">
                <Button className="flex-1 !text-xs" onPress={autoGroupByDomain}>域名分组</Button>
                <Button className="flex-1 !text-xs" onPress={collapseAllGroups}>折叠所有</Button>
                <Button className="flex-1 !text-xs" onPress={ungroupAll}>取消分组</Button>
            </div>
        </Card>
    </>
}
